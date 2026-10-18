/**
 * Places a `schema()` catalog into the namespace from `defineConfig`.
 *
 * `schema()` compiles `public`. Planning reads this copy, so two catalogs
 * on one database do not share table identities. An `external` table keeps
 * the namespace from its snapshot. A catalog that is already `public` and
 * has no external namespace is returned as itself, so its hash does not change.
 */

import { catalog } from "../../contracts/catalog/build.js";
import { staticNamespace } from "../../contracts/catalog/identity.js";
import type {
  Catalog,
  CatalogObject,
  ConstraintObject,
  DependencyEdge,
  Namespace,
  ObjectIdentity,
  ObjectRef,
} from "../../contracts/catalog/types.js";

/**
 * Rewrites managed objects into `namespace` and external tables into `externalNamespaces`.
 *
 * @param source - Catalog from `schema()`, after ownership is stamped
 * @param namespace - Postgres schema this catalog owns. `public` is the default
 * @param externalNamespaces - SQL table name to the owning catalog's namespace
 * @returns `source` when nothing moves, otherwise a new catalog
 */
export function placeCatalog(
  source: Catalog,
  namespace: string,
  externalNamespaces: ReadonlyMap<string, string>,
): Catalog {
  if (namespace === "public" && externalNamespaces.size === 0) return source;
  const homes = tableHomes(source, namespace, externalNamespaces);
  let changed = false;
  const objects = source.objects.map((object) => {
    const next = relocateObject(object, homes, namespace);
    if (next !== object) changed = true;
    return next;
  });
  if (!changed) return source;
  return catalog(objects);
}

function tableHomes(
  source: Catalog,
  namespace: string,
  externalNamespaces: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const homes = new Map<string, string>();
  for (const object of source.objects) {
    if (object.kind !== "table" && object.kind !== "view" && object.kind !== "materializedView") {
      continue;
    }
    const home =
      object.owner === "external"
        ? (externalNamespaces.get(object.identity.name) ?? namespace)
        : namespace;
    homes.set(object.identity.name, home);
  }
  return homes;
}

function relocateObject(
  object: CatalogObject,
  homes: ReadonlyMap<string, string>,
  namespace: string,
): CatalogObject {
  const dependencies = relocateEdges(object.dependencies, homes, namespace);
  if (object.kind === "extension") {
    if (object.definition.schema === "public" && namespace !== "public") {
      return { ...object, definition: { ...object.definition, schema: namespace }, dependencies };
    }
    return dependencies === object.dependencies ? object : { ...object, dependencies };
  }
  if (object.kind === "role") {
    return dependencies === object.dependencies ? object : { ...object, dependencies };
  }
  const identity = relocateIdentity(object.identity, homes, namespace);
  if (object.kind === "constraint") {
    const references = relocateReferences(object, homes);
    if (
      identity === object.identity &&
      references === object.definition.references &&
      dependencies === object.dependencies
    ) {
      return object;
    }
    if (references === undefined || references === object.definition.references) {
      return { ...object, identity, dependencies } as CatalogObject;
    }
    return {
      ...object,
      identity,
      definition: { ...object.definition, references },
      dependencies,
    } as CatalogObject;
  }
  if (object.kind === "trigger") {
    const calls = relocateCalls(object.definition.calls, namespace);
    if (
      identity === object.identity &&
      dependencies === object.dependencies &&
      calls === object.definition.calls
    ) {
      return object;
    }
    if (calls === object.definition.calls) {
      return { ...object, identity, dependencies } as CatalogObject;
    }
    return {
      ...object,
      identity,
      definition: { ...object.definition, calls },
      dependencies,
    } as CatalogObject;
  }
  if (identity === object.identity && dependencies === object.dependencies) return object;
  return { ...object, identity, dependencies } as CatalogObject;
}

/**
 * Moves a trigger's called function into the placed namespace.
 *
 * Dependency edges relocate separately. The call record must move too, or a
 * serialize/parse round trip rebuilds the edge from `calls.namespace` and
 * raises OKM1020 against the placed function (B-47).
 *
 * @param calls - Trigger call record from `schema()` (`public`)
 * @param namespace - Namespace from `defineConfig`
 * @returns The same record, or one with a moved namespace
 */
function relocateCalls(
  calls: {
    readonly namespace: Namespace;
    readonly name: string;
    readonly argTypes: readonly string[];
  },
  namespace: string,
): {
  readonly namespace: Namespace;
  readonly name: string;
  readonly argTypes: readonly string[];
} {
  const moved = moveNamespace(calls.namespace, namespace);
  if (moved === calls.namespace) return calls;
  return { ...calls, namespace: moved };
}

function relocateReferences(
  object: ConstraintObject,
  homes: ReadonlyMap<string, string>,
): ConstraintObject["definition"]["references"] {
  const references = object.definition.references;
  if (references === undefined) return undefined;
  const home = homes.get(references.parent.name);
  if (home === undefined) return references;
  const parent = moveRef(references.parent, home);
  if (parent === references.parent) return references;
  return { ...references, parent };
}

function relocateEdges(
  edges: readonly DependencyEdge[],
  homes: ReadonlyMap<string, string>,
  namespace: string,
): readonly DependencyEdge[] {
  let changed = false;
  const next = edges.map((edge) => {
    const target = relocateIdentity(edge.target, homes, namespace);
    if (target === edge.target) return edge;
    changed = true;
    return { target };
  });
  return changed ? next : edges;
}

function relocateIdentity(
  identity: ObjectIdentity,
  homes: ReadonlyMap<string, string>,
  namespace: string,
): ObjectIdentity {
  if (identity.kind === "role" || identity.kind === "extension") return identity;
  if (
    identity.kind === "column" ||
    identity.kind === "index" ||
    identity.kind === "constraint" ||
    identity.kind === "trigger" ||
    identity.kind === "policy"
  ) {
    const home = homes.get(identity.parent.name) ?? namespace;
    const parent = moveRef(identity.parent, home);
    if (parent === identity.parent) return identity;
    return { ...identity, parent };
  }
  if (identity.kind === "grant") {
    const home = homes.get(identity.object.name) ?? namespace;
    const moved = moveNamespace(identity.object.namespace, home);
    if (moved === identity.object.namespace) return identity;
    return { ...identity, object: { ...identity.object, namespace: moved } };
  }
  if (identity.kind === "defaultPrivilege") {
    const moved = moveNamespace(identity.namespace, namespace);
    if (moved === identity.namespace) return identity;
    return { ...identity, namespace: moved };
  }
  if (
    identity.kind === "table" ||
    identity.kind === "view" ||
    identity.kind === "materializedView" ||
    identity.kind === "sequence" ||
    identity.kind === "type" ||
    identity.kind === "function"
  ) {
    const home = homes.get(identity.name) ?? namespace;
    const moved = moveNamespace(identity.namespace, home);
    if (moved === identity.namespace) return identity;
    return { ...identity, namespace: moved };
  }
  return identity;
}

function moveRef(ref: ObjectRef, namespace: string): ObjectRef {
  const moved = moveNamespace(ref.namespace, namespace);
  if (moved === ref.namespace) return ref;
  return { ...ref, namespace: moved };
}

function moveNamespace(namespace: Namespace, name: string): Namespace {
  if (namespace.form !== "static" || namespace.name === name) return namespace;
  return staticNamespace(name);
}
