/**
 * Catalog documents.
 *
 * `catalog` checks identity, foreign keys, and cycles, then stores objects in
 * identity-key order. The serialized form is the canonical JSON of that
 * document, templates included. The hash is SHA-256 of those bytes.
 */

import { catalogError } from "../error.js";
import { fitIdentifier } from "./identifier.js";
import { sha256 } from "../sha256.js";
import { canonicalJson, type Json } from "./json.js";
import { replaceIdentifier } from "./rewrite.js";
import {
  identityKey,
  identityLabel,
  identityToJson,
  namespaceToJson,
  sameNamespace,
  sameRef,
  staticNamespace,
  templateNamespace,
} from "./identity.js";
import { catalog } from "./build.js";
import { domainType, enumType, isDomain } from "./enum.js";
import { extensionObject } from "./extension.js";
import { defaultPrivilegeObject, grantObject, roleObject } from "./privilege.js";
import { functionObject, triggerObject } from "./routine.js";
import { policyObject } from "./policy.js";
import { materializedViewIndex, materializedViewObject, viewObject } from "./view.js";
import { column, compareText, constraint, index, sequence, table } from "./object.js";
import { dependencyOrder } from "./order.js";
import type {
  Catalog,
  CatalogObject,
  ColumnObject,
  ConstraintObject,
  DependencyEdge,
  GrantObjectRef,
  IndexObject,
  MaterializedViewObject,
  Namespace,
  ObjectIdentity,
  ObjectRef,
  Owner,
  Provenance,
  ExtensionObject,
  SequenceObject,
  TableObject,
  ViewObject,
} from "./types.js";
import {
  BUILT_KINDS,
  CATALOG_VERSION,
  OWNERS,
  referentialAction,
  type ReferentialAction,
} from "./types.js";

export { catalog };

/**
 * Create order for a catalog.
 *
 * Ties break by identity key.
 *
 * @param source - Catalog document
 * @returns Dependencies first
 */
export function creationOrder(source: Catalog): readonly CatalogObject[] {
  return dependencyOrder(source.objects);
}

/**
 * Renames a column without renaming constraints or indexes.
 *
 * Column lists and edges that pointed at the old column move to the new name.
 * `nameKey` and the stored constraint or index name stay as they were.
 *
 * @param source - Catalog document
 * @param change - Parent table, current column name, and the new name
 * @returns A new catalog
 */
export function renameColumn(
  source: Catalog,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
): Catalog {
  const fromIdentity: ObjectIdentity = {
    kind: "column",
    parent: change.parent,
    name: change.from,
  };
  const toIdentity: ObjectIdentity = {
    kind: "column",
    parent: change.parent,
    name: change.to,
  };
  const fromKey = identityKey(fromIdentity);
  const found = source.objects.some((object) => identityKey(object.identity) === fromKey);
  if (!found) {
    catalogError("OKM1020", `Column ${change.from} is not in the catalog.`);
  }
  const next = source.objects.map((object) => rewriteRenamed(object, change, fromKey, toIdentity));
  return catalog(next);
}

/**
 * Renames a table without renaming its constraints or indexes.
 *
 * Column, index, constraint, and trigger parents move to the new name, and
 * edges that pointed at those objects move with them. Expression text that
 * names the table is rewritten. Constraint and index names stay. A grant on
 * the table, or on an identity sequence named `{table}_{column}_seq`, follows
 * the name the schema will use. The planner emits the `RENAME` for a default
 * name; a custom name is left as it is.
 *
 * @param source - Catalog document
 * @param change - Namespace, current table name, and the new name
 * @returns A new catalog
 */
export function renameTable(
  source: Catalog,
  change: { readonly namespace: Namespace; readonly from: string; readonly to: string },
): Catalog {
  const fromIdentity: ObjectIdentity = {
    kind: "table",
    namespace: change.namespace,
    name: change.from,
  };
  const toIdentity: ObjectIdentity = {
    kind: "table",
    namespace: change.namespace,
    name: change.to,
  };
  const fromKey = identityKey(fromIdentity);
  const found = source.objects.some((object) => identityKey(object.identity) === fromKey);
  if (!found) {
    catalogError("OKM1020", `Table ${change.from} is not in the catalog.`);
  }
  const next = source.objects.map((object) =>
    rewriteTableName(object, change, fromKey, toIdentity, source),
  );
  return catalog(next);
}

/**
 * Canonical JSON for a catalog.
 *
 * Templates stay templates. Object keys are sorted and objects are ordered by
 * identity key, so input order does not change the bytes.
 *
 * @param source - Catalog document
 * @returns Canonical text
 */
const serializedText = new WeakMap<Catalog, string>();
const serializedHash = new WeakMap<Catalog, string>();

export function serializeCatalog(source: Catalog): string {
  const cached = serializedText.get(source);
  if (cached !== undefined) return cached;
  const indexed = source.objects.map((object) => ({
    object,
    key: identityKey(object.identity),
  }));
  indexed.sort((left, right) => compareText(left.key, right.key));
  const text = canonicalJson({
    objects: indexed.map((item) => objectToJson(item.object)),
    version: source.version,
  });
  serializedText.set(source, text);
  return text;
}

/**
 * SHA-256 of {@link serializeCatalog}.
 *
 * The hash covers the normalised structure. It does not cover a separate
 * authoring document.
 *
 * @param source - Catalog document
 * @returns Lowercase hex digest
 */
export function catalogHash(source: Catalog): string {
  const cached = serializedHash.get(source);
  if (cached !== undefined) return cached;
  const hash = sha256(serializeCatalog(source));
  serializedHash.set(source, hash);
  return hash;
}

/**
 * The catalog `connect()` compares with `okm_meta` (D208).
 *
 * Roles, grants, and default privileges come from the migration config, not
 * the schema, so they are left out. A `schema()` catalog never has them, so
 * `connect()` hashes it unchanged. `okm check` still verifies them. A
 * catalog without them is returned as is.
 *
 * @param source - Catalog document
 * @returns The catalog without role, grant, and default-privilege objects
 */
export function startupCatalog(source: Catalog): Catalog {
  if (!source.objects.some(isPrivilege)) return source;
  return { version: source.version, objects: source.objects.filter((item) => !isPrivilege(item)) };
}

/**
 * {@link catalogHash} of {@link startupCatalog}. The hash `okm_meta` and
 * `okm_history` store, and the one `connect()` computes.
 *
 * @param source - Catalog document
 * @returns Lowercase hex digest
 */
export function startupHash(source: Catalog): string {
  return catalogHash(startupCatalog(source));
}

function isPrivilege(object: CatalogObject): boolean {
  return object.kind === "role" || object.kind === "grant" || object.kind === "defaultPrivilege";
}

/**
 * Loads a build artifact without validating objects.
 *
 * `okm build` already validated the catalog. Production startup checks the
 * stored hash and the version, then trusts the objects (D133). `okm check`
 * and dev keep {@link parseCatalog}.
 *
 * @param text - Canonical catalog JSON
 * @param hash - SHA-256 of `text`, stored beside the artifact
 * @returns The catalog document
 */
export function loadTrustedCatalog(text: string, hash: string): Catalog {
  if (sha256(text) !== hash) {
    catalogError("OKM1027", "Catalog hash does not match the build artifact.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    catalogError("OKM1027", "Catalog text is not valid JSON.");
  }
  if (!isPlainRecord(parsed) || !Array.isArray(parsed.objects)) {
    catalogError("OKM1027", "Catalog document is not an object.");
  }
  if (parsed.version !== CATALOG_VERSION) {
    catalogError(
      "OKM1027",
      `Catalog version ${String(parsed.version)} cannot be read. This build reads version ${String(CATALOG_VERSION)}.`,
    );
  }
  const loaded: Catalog = {
    version: CATALOG_VERSION,
    objects: parsed.objects as Catalog["objects"],
  };
  serializedText.set(loaded, text);
  serializedHash.set(loaded, hash);
  return loaded;
}

/**
 * Reads canonical catalog JSON.
 *
 * @param text - Serialized catalog
 * @returns A checked catalog
 */
export function parseCatalog(text: string): Catalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    catalogError("OKM1027", "Catalog text is not valid JSON.");
  }
  if (!isPlainRecord(parsed)) {
    catalogError("OKM1027", "Catalog document is not an object.");
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "objects" && key !== "version") {
      catalogError("OKM1027", `Catalog has unexpected field ${key}.`);
    }
  }
  if (parsed.version !== CATALOG_VERSION) {
    catalogError(
      "OKM1027",
      `Catalog version ${String(parsed.version)} cannot be read. This build reads version ${String(CATALOG_VERSION)}.`,
    );
  }
  if (!Array.isArray(parsed.objects)) {
    catalogError("OKM1027", "Catalog field objects must be an array.");
  }
  return catalog(parsed.objects.map((item) => parseObject(item)));
}

function rewriteRenamed(
  object: CatalogObject,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  fromKey: string,
  toIdentity: ObjectIdentity,
): CatalogObject {
  const dependencies = retarget(object.dependencies, fromKey, toIdentity);
  switch (object.kind) {
    case "table":
      return rewriteTable(object, change, dependencies);
    case "column":
      return rewriteColumn(object, change, dependencies);
    case "index":
      return rewriteIndex(object, change, dependencies);
    case "constraint":
      return rewriteConstraint(object, change, dependencies);
    case "sequence":
      return rewriteSequence(object, dependencies);
    case "type":
      return rewriteType(object, dependencies);
    case "extension":
      return retargeted(object, dependencies);
    case "function": {
      const local = object.dependencies.some(
        (edge) => edge.target.kind === "column" && sameRef(edge.target.parent, change.parent),
      );
      return functionObject({
        namespace: object.identity.namespace,
        name: object.identity.name,
        arguments: object.definition.arguments,
        returns: object.definition.returns,
        language: object.definition.language,
        volatility: object.definition.volatility,
        security: object.definition.security,
        body: rewriteExpr(object.definition.body, change, local),
        owner: object.owner,
        provenance: object.provenance,
        dependencies,
        ...(object.definition.searchPath !== undefined
          ? { searchPath: object.definition.searchPath }
          : {}),
        ...(object.definition.atomic === true ? { atomic: true } : {}),
      });
    }
    case "view":
    case "materializedView": {
      const local = object.dependencies.some(
        (edge) => edge.target.kind === "column" && sameRef(edge.target.parent, change.parent),
      );
      return rewriteView(object, dependencies, rewriteExpr(object.definition.query, change, local));
    }
    case "role":
    case "grant":
    case "defaultPrivilege":
      return retargeted(object, dependencies);
    case "policy":
      return rewritePolicyColumn(object, change, dependencies);
    case "trigger": {
      const local = sameRef(object.identity.parent, change.parent);
      return triggerObject({
        parent: object.identity.parent,
        name: object.identity.name,
        timing: object.definition.timing,
        events: object.definition.events,
        level: object.definition.level,
        calls: object.definition.calls,
        owner: object.owner,
        provenance: object.provenance,
        dependencies,
        ...(object.definition.updateOf !== undefined
          ? {
              updateOf: local
                ? renameList(object.definition.updateOf, change.from, change.to)
                : object.definition.updateOf,
            }
          : {}),
        ...(object.definition.when !== undefined
          ? { when: rewriteExpr(object.definition.when, change, local) }
          : {}),
      });
    }
    default:
      return assertNever(object);
  }
}

function retargeted(object: CatalogObject, dependencies: readonly ObjectIdentity[]): CatalogObject {
  return { ...object, dependencies: dependencies.map((target) => ({ target })) };
}

function rewriteTable(
  object: TableObject,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  dependencies: readonly ObjectIdentity[],
): TableObject {
  const partition = object.definition.partition;
  const renamed =
    partition !== undefined &&
    object.identity.name === change.parent.name &&
    sameNamespace(object.identity.namespace, change.parent.namespace);
  return table({
    namespace: object.identity.namespace,
    name: object.identity.name,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
    ...(partition === undefined
      ? {}
      : {
          partition: {
            method: partition.method,
            columns: renamed
              ? partition.columns.map((name) => (name === change.from ? change.to : name))
              : [...partition.columns],
          },
        }),
  });
}

function rewriteColumn(
  object: ColumnObject,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  dependencies: readonly ObjectIdentity[],
): ColumnObject {
  const renamed =
    sameRef(object.identity.parent, change.parent) && object.identity.name === change.from;
  const definition = object.definition;
  const local = sameRef(object.identity.parent, change.parent);
  return column({
    parent: object.identity.parent,
    name: renamed ? change.to : object.identity.name,
    dataType: definition.dataType,
    nullable: definition.nullable,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
    ...(definition.defaultExpression !== undefined
      ? { defaultExpression: rewriteExpr(definition.defaultExpression, change, local) }
      : {}),
    ...(definition.collation !== undefined ? { collation: definition.collation } : {}),
    ...(definition.identity !== undefined ? { identity: definition.identity } : {}),
    ...(definition.generated !== undefined
      ? {
          generated: {
            stored: definition.generated.stored,
            expression: rewriteExpr(definition.generated.expression, change, local),
          },
        }
      : {}),
  });
}

function rewriteIndex(
  object: IndexObject,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  dependencies: readonly ObjectIdentity[],
): IndexObject {
  const local = sameRef(object.identity.parent, change.parent);
  const definition = object.definition;
  return indexAgain(object, object.identity.parent, dependencies, {
    columns: local
      ? renameList(definition.columns, change.from, change.to)
      : [...definition.columns],
    ...(definition.predicate !== undefined
      ? { predicate: rewriteExpr(definition.predicate, change, local) }
      : {}),
    ...(definition.expression !== undefined
      ? { expression: rewriteExpr(definition.expression, change, local) }
      : {}),
  });
}

function indexAgain(
  object: IndexObject,
  parent: ObjectRef,
  dependencies: readonly ObjectIdentity[],
  patch: {
    readonly columns: readonly string[];
    readonly predicate?: string;
    readonly expression?: string;
  },
): IndexObject {
  const onView = dependencies.some(
    (edge) => edge.kind === "view" || edge.kind === "materializedView",
  );
  if (onView) {
    return materializedViewIndex({
      parent,
      name: object.identity.name,
      nameKey: object.definition.nameKey,
      columns: patch.columns,
      unique: object.definition.unique,
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
      ...(patch.predicate !== undefined ? { predicate: patch.predicate } : {}),
      ...(patch.expression !== undefined ? { expression: patch.expression } : {}),
    });
  }
  return index({
    parent,
    name: object.identity.name,
    nameKey: object.definition.nameKey,
    columns: patch.columns,
    unique: object.definition.unique,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
    ...(patch.predicate !== undefined ? { predicate: patch.predicate } : {}),
    ...(patch.expression !== undefined ? { expression: patch.expression } : {}),
  });
}

function rewriteConstraint(
  object: ConstraintObject,
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  dependencies: readonly ObjectIdentity[],
): ConstraintObject {
  const definition = object.definition;
  const local = sameRef(object.identity.parent, change.parent);
  const references = definition.references;
  const referenced =
    references !== undefined && sameRef(references.parent, change.parent)
      ? {
          parent: references.parent,
          columns: renameList(references.columns, change.from, change.to),
          ...(references.onDelete !== undefined ? { onDelete: references.onDelete } : {}),
          ...(references.onUpdate !== undefined ? { onUpdate: references.onUpdate } : {}),
        }
      : references;
  return constraint({
    parent: object.identity.parent,
    constraintKind: definition.constraintKind,
    name: object.identity.name,
    nameKey: definition.nameKey,
    columns: local
      ? renameList(definition.columns, change.from, change.to)
      : [...definition.columns],
    deferrable: definition.deferrable,
    initially: definition.initially,
    nullsNotDistinct: definition.nullsNotDistinct,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
    ...(definition.expression !== undefined
      ? { expression: rewriteExpr(definition.expression, change, local) }
      : {}),
    ...(referenced !== undefined ? { references: referenced } : {}),
  });
}

function rewriteView(
  object: ViewObject | MaterializedViewObject,
  dependencies: readonly ObjectIdentity[],
  query: string,
): CatalogObject {
  const input = {
    namespace: object.identity.namespace,
    name: object.identity.name,
    columns: object.definition.columns,
    query,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
  };
  if (object.kind === "materializedView") {
    return materializedViewObject({
      ...input,
      ...(object.definition.refresh !== undefined ? { refresh: object.definition.refresh } : {}),
    });
  }
  return viewObject({
    ...input,
    ...(object.definition.securityInvoker === true ? { securityInvoker: true as const } : {}),
  });
}

function rewritePolicyColumn(
  object: CatalogObject & { readonly kind: "policy" },
  change: { readonly parent: ObjectRef; readonly from: string; readonly to: string },
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  const local = sameRef(object.identity.parent, change.parent);
  return policyObject({
    parent: object.identity.parent,
    name: object.identity.name,
    command: object.definition.command,
    expression: rewriteExpr(object.definition.expression, change, local),
    force: object.definition.force,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
  });
}

function rewriteExpr(
  text: string,
  change: { readonly from: string; readonly to: string },
  active: boolean,
): string {
  if (!active) return text;
  return replaceIdentifier(text, change.from, change.to);
}

function rewriteTableName(
  object: CatalogObject,
  change: { readonly namespace: Namespace; readonly from: string; readonly to: string },
  fromKey: string,
  toIdentity: ObjectIdentity,
  source: Catalog,
): CatalogObject {
  const dependencies = retarget(object.dependencies, fromKey, toIdentity, change);
  const named =
    object.kind === "table" &&
    object.identity.name === change.from &&
    sameNamespace(object.identity.namespace, change.namespace);
  if (object.kind === "table") {
    return table({
      namespace: object.identity.namespace,
      name: named ? change.to : object.identity.name,
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
      ...(object.definition.partition === undefined
        ? {}
        : { partition: object.definition.partition }),
    });
  }
  if (object.kind === "column" || object.kind === "index" || object.kind === "constraint") {
    const parent = movedParent(object.identity.parent, change);
    const local = parent.name !== object.identity.parent.name;
    if (object.kind === "column") {
      return column({
        parent,
        name: object.identity.name,
        dataType: object.definition.dataType,
        nullable: object.definition.nullable,
        owner: object.owner,
        provenance: object.provenance,
        dependencies,
        ...(object.definition.defaultExpression !== undefined
          ? {
              defaultExpression: rewriteExpr(
                object.definition.defaultExpression,
                { from: change.from, to: change.to },
                local,
              ),
            }
          : {}),
        ...(object.definition.collation !== undefined
          ? { collation: object.definition.collation }
          : {}),
        ...(object.definition.identity !== undefined
          ? { identity: object.definition.identity }
          : {}),
        ...(object.definition.generated !== undefined
          ? { generated: object.definition.generated }
          : {}),
      });
    }
    if (object.kind === "index") {
      return indexAgain(object, parent, dependencies, {
        columns: [...object.definition.columns],
        ...(object.definition.predicate !== undefined
          ? {
              predicate: rewriteExpr(
                object.definition.predicate,
                { from: change.from, to: change.to },
                local,
              ),
            }
          : {}),
        ...(object.definition.expression !== undefined
          ? {
              expression: rewriteExpr(
                object.definition.expression,
                { from: change.from, to: change.to },
                local,
              ),
            }
          : {}),
      });
    }
    const references = object.definition.references;
    const referenced =
      references === undefined
        ? undefined
        : {
            parent: movedParent(references.parent, change),
            columns: [...references.columns],
            ...(references.onDelete !== undefined ? { onDelete: references.onDelete } : {}),
            ...(references.onUpdate !== undefined ? { onUpdate: references.onUpdate } : {}),
          };
    return constraint({
      parent,
      constraintKind: object.definition.constraintKind,
      name: object.identity.name,
      nameKey: object.definition.nameKey,
      columns: [...object.definition.columns],
      deferrable: object.definition.deferrable,
      initially: object.definition.initially,
      nullsNotDistinct: object.definition.nullsNotDistinct,
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
      ...(object.definition.expression !== undefined
        ? {
            expression: rewriteExpr(
              object.definition.expression,
              { from: change.from, to: change.to },
              local,
            ),
          }
        : {}),
      ...(referenced !== undefined ? { references: referenced } : {}),
    });
  }
  if (object.kind === "sequence") return rewriteSequence(object, dependencies);
  if (object.kind === "type") return rewriteType(object, dependencies);
  if (object.kind === "extension") {
    return { ...object, dependencies: dependencies.map((target) => ({ target })) };
  }
  if (object.kind === "function") {
    const local = object.dependencies.some(
      (edge) =>
        edge.target.kind === "table" &&
        edge.target.name === change.from &&
        sameNamespace(edge.target.namespace, change.namespace),
    );
    return functionObject({
      namespace: object.identity.namespace,
      name: object.identity.name,
      arguments: object.definition.arguments,
      returns: object.definition.returns,
      language: object.definition.language,
      volatility: object.definition.volatility,
      security: object.definition.security,
      body: rewriteExpr(object.definition.body, { from: change.from, to: change.to }, local),
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
      ...(object.definition.searchPath !== undefined
        ? { searchPath: object.definition.searchPath }
        : {}),
      ...(object.definition.atomic === true ? { atomic: true } : {}),
    });
  }
  if (object.kind === "view" || object.kind === "materializedView") {
    const local = object.dependencies.some((edge) => {
      if (edge.target.kind === "table") {
        return (
          edge.target.name === change.from && sameNamespace(edge.target.namespace, change.namespace)
        );
      }
      if (edge.target.kind === "column") {
        return (
          edge.target.parent.name === change.from &&
          sameNamespace(edge.target.parent.namespace, change.namespace)
        );
      }
      return false;
    });
    return rewriteView(
      object,
      dependencies,
      rewriteExpr(object.definition.query, { from: change.from, to: change.to }, local),
    );
  }
  if (object.kind === "role" || object.kind === "defaultPrivilege") {
    return retargeted(object, dependencies);
  }
  if (object.kind === "grant") {
    return grantObject({
      role: object.identity.role,
      object: movedGrantRef(object.identity.object, change, source),
      privilege: object.identity.privilege,
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
    });
  }
  if (object.kind === "trigger") {
    const parent = movedParent(object.identity.parent, change);
    const local = parent.name !== object.identity.parent.name;
    return triggerObject({
      parent,
      name: object.identity.name,
      timing: object.definition.timing,
      events: object.definition.events,
      level: object.definition.level,
      calls: object.definition.calls,
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
      ...(object.definition.updateOf !== undefined ? { updateOf: object.definition.updateOf } : {}),
      ...(object.definition.when !== undefined
        ? { when: rewriteExpr(object.definition.when, { from: change.from, to: change.to }, local) }
        : {}),
    });
  }
  if (object.kind === "policy") {
    const parent = movedParent(object.identity.parent, change);
    const local = parent.name !== object.identity.parent.name;
    return policyObject({
      parent,
      name: object.identity.name,
      command: object.definition.command,
      expression: rewriteExpr(
        object.definition.expression,
        { from: change.from, to: change.to },
        local,
      ),
      force: object.definition.force,
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
    });
  }
  return assertNever(object);
}

function movedParent(
  parent: ObjectRef,
  change: { readonly namespace: Namespace; readonly from: string; readonly to: string },
): ObjectRef {
  if (parent.name === change.from && sameNamespace(parent.namespace, change.namespace)) {
    return { namespace: parent.namespace, name: change.to };
  }
  return parent;
}

function rewriteType(
  object: CatalogObject & { readonly kind: "type" },
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (isDomain(object.definition)) {
    return domainType({
      namespace: object.identity.namespace,
      name: object.identity.name,
      base: object.definition.base,
      check: object.definition.check,
      owner: object.owner,
      provenance: object.provenance,
      dependencies,
    });
  }
  return enumType({
    namespace: object.identity.namespace,
    name: object.identity.name,
    labels: object.definition.labels,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
  });
}

function rewriteSequence(
  object: SequenceObject,
  dependencies: readonly ObjectIdentity[],
): SequenceObject {
  return sequence({
    namespace: object.identity.namespace,
    name: object.identity.name,
    dataType: object.definition.dataType,
    start: object.definition.start,
    increment: object.definition.increment,
    cycle: object.definition.cycle,
    owner: object.owner,
    provenance: object.provenance,
    dependencies,
  });
}

function renameList(names: readonly string[], from: string, to: string): string[] {
  return names.map((name) => (name === from ? to : name));
}

function retarget(
  edges: readonly DependencyEdge[],
  fromKey: string,
  to: ObjectIdentity,
  change?: { readonly namespace: Namespace; readonly from: string; readonly to: string },
): ObjectIdentity[] {
  return edges.map((edge) => {
    if (identityKey(edge.target) === fromKey) return to;
    if (change === undefined) return edge.target;
    return movedChild(edge.target, change);
  });
}

function movedChild(
  target: ObjectIdentity,
  change: { readonly namespace: Namespace; readonly from: string; readonly to: string },
): ObjectIdentity {
  if (!("parent" in target)) return target;
  if (
    target.parent.name !== change.from ||
    !sameNamespace(target.parent.namespace, change.namespace)
  ) {
    return target;
  }
  return { ...target, parent: { namespace: target.parent.namespace, name: change.to } };
}

function movedGrantRef(
  object: GrantObjectRef,
  change: { readonly namespace: Namespace; readonly from: string; readonly to: string },
  source: Catalog,
): GrantObjectRef {
  if (
    object.kind === "table" &&
    object.name === change.from &&
    sameNamespace(object.namespace, change.namespace)
  ) {
    return { ...object, name: change.to };
  }
  if (object.kind !== "sequence") return object;
  const next = renamedIdentitySequence(source, change, object.name);
  if (next === undefined) return object;
  return { ...object, name: next };
}

function renamedIdentitySequence(
  source: Catalog,
  change: { readonly namespace: Namespace; readonly from: string; readonly to: string },
  sequenceName: string,
): string | undefined {
  for (const object of source.objects) {
    if (object.kind !== "column" || object.definition.identity === undefined) continue;
    if (
      object.identity.parent.name !== change.from ||
      !sameNamespace(object.identity.parent.namespace, change.namespace)
    ) {
      continue;
    }
    if (fitIdentifier(`${change.from}_${object.identity.name}_seq`) !== sequenceName) continue;
    return fitIdentifier(`${change.to}_${object.identity.name}_seq`);
  }
  return undefined;
}

function dependencyJson(edges: readonly DependencyEdge[]): Json[] {
  const indexed = edges.map((edge) => ({
    key: identityKey(edge.target),
    target: identityToJson(edge.target),
  }));
  indexed.sort((left, right) => compareText(left.key, right.key));
  return indexed.map((item) => ({ target: item.target }));
}

function objectToJson(object: CatalogObject): Json {
  const dependencies = dependencyJson(object.dependencies);
  return {
    definition: definitionToJson(object),
    dependencies,
    identity: identityToJson(object.identity),
    kind: object.kind,
    owner: object.owner,
    // `source` stays off the document. A line number is not part of the hash.
    provenance: { name: object.provenance.name, origin: object.provenance.origin },
  };
}

function definitionToJson(object: CatalogObject): Json {
  switch (object.kind) {
    case "table": {
      const partition = object.definition.partition;
      if (partition === undefined) {
        return {};
      }
      return { partition: { columns: partition.columns, method: partition.method } };
    }
    case "column": {
      const definition = object.definition;
      return {
        dataType: definition.dataType,
        nullable: definition.nullable,
        ...(definition.defaultExpression !== undefined
          ? { defaultExpression: definition.defaultExpression }
          : {}),
        ...(definition.collation !== undefined ? { collation: definition.collation } : {}),
        ...(definition.identity !== undefined
          ? { identity: { always: definition.identity.always } }
          : {}),
        ...(definition.generated !== undefined
          ? {
              generated: {
                expression: definition.generated.expression,
                stored: definition.generated.stored,
              },
            }
          : {}),
      };
    }
    case "index": {
      const definition = object.definition;
      return {
        columns: definition.columns,
        nameKey: definition.nameKey,
        unique: definition.unique,
        ...(definition.expression !== undefined ? { expression: definition.expression } : {}),
        ...(definition.predicate !== undefined ? { predicate: definition.predicate } : {}),
      };
    }
    case "constraint": {
      const definition = object.definition;
      const references = definition.references;
      return {
        columns: definition.columns,
        constraintKind: definition.constraintKind,
        deferrable: definition.deferrable,
        initially: definition.initially,
        nameKey: definition.nameKey,
        nullsNotDistinct: definition.nullsNotDistinct,
        ...(definition.expression !== undefined ? { expression: definition.expression } : {}),
        ...(references !== undefined
          ? {
              references: {
                columns: references.columns,
                ...(references.onDelete !== undefined ? { onDelete: references.onDelete } : {}),
                ...(references.onUpdate !== undefined ? { onUpdate: references.onUpdate } : {}),
                parent: {
                  name: references.parent.name,
                  namespace: namespaceToJson(references.parent.namespace),
                },
              },
            }
          : {}),
      };
    }
    case "sequence":
      return {
        cycle: object.definition.cycle,
        dataType: object.definition.dataType,
        increment: object.definition.increment,
        start: object.definition.start,
      };
    case "type":
      return isDomain(object.definition)
        ? { base: object.definition.base, check: object.definition.check }
        : { labels: object.definition.labels };
    case "extension": {
      const definition = object.definition;
      return {
        relocatable: definition.relocatable,
        schema: definition.schema,
        ...(definition.version !== undefined ? { version: definition.version } : {}),
      };
    }
    case "function": {
      const definition = object.definition;
      return {
        arguments: definition.arguments.map((argument) => ({
          name: argument.name,
          type: argument.type,
        })),
        body: definition.body,
        language: definition.language,
        returns: definition.returns,
        security: definition.security,
        volatility: definition.volatility,
        ...(definition.atomic === true ? { atomic: true } : {}),
        ...(definition.searchPath !== undefined ? { searchPath: definition.searchPath } : {}),
      };
    }
    case "trigger": {
      const definition = object.definition;
      return {
        calls: {
          argTypes: [...definition.calls.argTypes],
          name: definition.calls.name,
          namespace: namespaceToJson(definition.calls.namespace),
        },
        events: [...definition.events],
        level: definition.level,
        timing: definition.timing,
        ...(definition.updateOf !== undefined ? { updateOf: [...definition.updateOf] } : {}),
        ...(definition.when !== undefined ? { when: definition.when } : {}),
      };
    }
    case "view":
      return {
        columns: object.definition.columns.map((column) => ({
          dataType: column.dataType,
          name: column.name,
        })),
        query: object.definition.query,
        ...(object.definition.securityInvoker === true ? { securityInvoker: true } : {}),
      };
    case "policy":
      return {
        command: object.definition.command,
        expression: object.definition.expression,
        force: object.definition.force,
      };
    case "materializedView":
      return {
        columns: object.definition.columns.map((column) => ({
          dataType: column.dataType,
          name: column.name,
        })),
        query: object.definition.query,
        ...(object.definition.refresh !== undefined ? { refresh: object.definition.refresh } : {}),
      };
    case "role":
      return { inherit: object.definition.inherit, login: object.definition.login };
    case "grant":
    case "defaultPrivilege":
      return {};
    default:
      return assertNever(object);
  }
}

function parseObject(value: unknown): CatalogObject {
  const record = requireRecord(value, "catalog object");
  rejectUnknown(
    record,
    ["definition", "dependencies", "identity", "kind", "owner", "provenance"],
    "catalog object",
  );
  const kind = requireString(record.kind, "kind");
  if (kind === "policy") return parsePolicy(record);
  if (!isBuiltKind(kind)) {
    catalogError(
      "OKM1020",
      `Kind ${kind} is not built yet. Built kinds are ${BUILT_KINDS.join(", ")}.`,
    );
  }
  const identity = parseIdentity(record.identity);
  if (identity.kind !== kind) {
    catalogError("OKM1020", `${identityLabel(identity)} has kind ${kind}.`);
  }
  const owner = parseOwner(record.owner);
  const provenance = parseProvenance(record.provenance);
  const dependencies = parseDependencies(record.dependencies);
  const definition = requireRecord(record.definition, "definition");
  switch (kind) {
    case "table":
      return parseTable(identity, definition, owner, provenance, dependencies);
    case "column":
      return parseColumn(identity, definition, owner, provenance, dependencies);
    case "index":
      return parseIndex(identity, definition, owner, provenance, dependencies);
    case "constraint":
      return parseConstraint(identity, definition, owner, provenance, dependencies);
    case "sequence":
      return parseSequence(identity, definition, owner, provenance, dependencies);
    case "type":
      return parseType(identity, definition, owner, provenance, dependencies);
    case "extension":
      return parseExtension(identity, definition, owner, provenance, dependencies);
    case "function":
      return parseFunction(identity, definition, owner, provenance, dependencies);
    case "trigger":
      return parseTrigger(identity, definition, owner, provenance, dependencies);
    case "view":
    case "materializedView":
      return parseView(kind, identity, definition, owner, provenance, dependencies);
    case "role":
      return parseRole(identity, definition, owner, provenance, dependencies);
    case "grant":
      return parseGrant(identity, definition, owner, provenance, dependencies);
    case "defaultPrivilege":
      return parseDefaultPrivilege(identity, definition, owner, provenance, dependencies);
    default:
      return assertNeverKind(kind);
  }
}

function parseTable(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "table") {
    catalogError("OKM1020", `Table object identity is ${identity.kind}, not a table.`);
  }
  rejectUnknown(definition, ["partition"], "table definition");
  const partition = definition.partition;
  return table({
    namespace: identity.namespace,
    name: identity.name,
    owner,
    provenance,
    dependencies,
    ...(partition === undefined ? {} : { partition: parsePartition(partition) }),
  });
}

function parseColumn(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "column") {
    catalogError("OKM1020", `Column object identity is ${identity.kind}, not a column.`);
  }
  rejectUnknown(
    definition,
    ["collation", "dataType", "defaultExpression", "generated", "identity", "nullable"],
    "column definition",
  );
  const generated = definition.generated;
  const columnIdentity = definition.identity;
  return column({
    parent: identity.parent,
    name: identity.name,
    dataType: requireString(definition.dataType, "data type"),
    nullable: requireBoolean(definition.nullable, "nullable"),
    owner,
    provenance,
    dependencies,
    ...(definition.defaultExpression === undefined
      ? {}
      : { defaultExpression: requireString(definition.defaultExpression, "default") }),
    ...(definition.collation === undefined
      ? {}
      : { collation: requireString(definition.collation, "collation") }),
    ...(columnIdentity === undefined ? {} : { identity: parseAlways(columnIdentity) }),
    ...(generated === undefined ? {} : { generated: parseGenerated(generated) }),
  });
}

function parseIndex(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "index") {
    catalogError("OKM1020", `Index object identity is ${identity.kind}, not an index.`);
  }
  rejectUnknown(
    definition,
    ["columns", "expression", "nameKey", "predicate", "unique"],
    "index definition",
  );
  return index({
    parent: identity.parent,
    name: identity.name,
    nameKey: requireString(definition.nameKey, "name key"),
    columns: requireStrings(definition.columns, "index columns"),
    unique: requireBoolean(definition.unique, "unique"),
    owner,
    provenance,
    dependencies,
    ...(definition.predicate === undefined
      ? {}
      : { predicate: requireString(definition.predicate, "predicate") }),
    ...(definition.expression === undefined
      ? {}
      : { expression: requireString(definition.expression, "expression") }),
  });
}

function parseConstraint(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "constraint") {
    catalogError("OKM1020", `Constraint object identity is ${identity.kind}, not a constraint.`);
  }
  rejectUnknown(
    definition,
    [
      "columns",
      "constraintKind",
      "deferrable",
      "expression",
      "initially",
      "nameKey",
      "nullsNotDistinct",
      "references",
    ],
    "constraint definition",
  );
  const constraintKind = requireString(definition.constraintKind, "constraint kind");
  if (
    constraintKind !== "primaryKey" &&
    constraintKind !== "unique" &&
    constraintKind !== "foreignKey" &&
    constraintKind !== "check"
  ) {
    catalogError(
      "OKM1020",
      `Constraint kind ${constraintKind} must be primaryKey, unique, foreignKey, or check.`,
    );
  }
  const initially = requireString(definition.initially, "initially");
  if (initially !== "immediate" && initially !== "deferred") {
    catalogError("OKM1020", `Constraint initially ${initially} must be immediate or deferred.`);
  }
  const references = definition.references;
  return constraint({
    parent: identity.parent,
    constraintKind,
    name: identity.name,
    nameKey: requireString(definition.nameKey, "name key"),
    columns: requireStrings(definition.columns, "constraint columns"),
    deferrable: requireBoolean(definition.deferrable, "deferrable"),
    initially,
    nullsNotDistinct: requireBoolean(definition.nullsNotDistinct, "nulls not distinct"),
    owner,
    provenance,
    dependencies,
    ...(definition.expression === undefined
      ? {}
      : { expression: requireString(definition.expression, "expression") }),
    ...(references === undefined ? {} : { references: parseReferences(references) }),
  });
}

function parseSequence(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "sequence") {
    catalogError("OKM1020", `Sequence object identity is ${identity.kind}, not a sequence.`);
  }
  rejectUnknown(definition, ["cycle", "dataType", "increment", "start"], "sequence definition");
  const dataType = requireString(definition.dataType, "sequence type");
  if (dataType !== "smallint" && dataType !== "integer" && dataType !== "bigint") {
    catalogError("OKM1020", `Sequence type ${dataType} must be smallint, integer, or bigint.`);
  }
  return sequence({
    namespace: identity.namespace,
    name: identity.name,
    dataType,
    start: requireString(definition.start, "sequence start"),
    increment: requireString(definition.increment, "sequence increment"),
    cycle: requireBoolean(definition.cycle, "cycle"),
    owner,
    provenance,
    dependencies,
  });
}

function parseType(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "type") {
    catalogError("OKM1020", `Type object identity is ${identity.kind}, not a type.`);
  }
  if ("base" in definition || "check" in definition) {
    rejectUnknown(definition, ["base", "check"], "type definition");
    return domainType({
      namespace: identity.namespace,
      name: identity.name,
      base: requireString(definition.base, "domain base"),
      check: requireString(definition.check, "domain check"),
      owner,
      provenance,
      dependencies,
    });
  }
  rejectUnknown(definition, ["labels"], "type definition");
  return enumType({
    namespace: identity.namespace,
    name: identity.name,
    labels: requireStrings(definition.labels, "enum labels"),
    owner,
    provenance,
    dependencies,
  });
}

function parseFunction(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "function") {
    catalogError("OKM1020", `Function object identity is ${identity.kind}, not a function.`);
  }
  rejectUnknown(
    definition,
    ["arguments", "atomic", "body", "language", "returns", "searchPath", "security", "volatility"],
    "function definition",
  );
  const language = requireString(definition.language, "function language");
  if (language !== "sql" && language !== "plpgsql") {
    catalogError("OKM1020", `Function ${identity.name} language must be sql or plpgsql.`);
  }
  const volatility = parseVolatility(definition.volatility);
  const security = parseSecurity(definition.security);
  return functionObject({
    namespace: identity.namespace,
    name: identity.name,
    arguments: parseArguments(definition.arguments),
    returns: requireString(definition.returns, "function returns"),
    language,
    body: requireString(definition.body, "function body"),
    owner,
    provenance,
    dependencies,
    ...(volatility !== undefined ? { volatility } : {}),
    ...(security !== undefined ? { security } : {}),
    ...(definition.atomic === true ? { atomic: true } : {}),
    ...(definition.searchPath !== undefined
      ? { searchPath: requireString(definition.searchPath, "search path") }
      : {}),
  });
}

function parseArguments(value: unknown): { readonly name: string; readonly type: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) catalogError("OKM1020", "Function arguments must be an array.");
  return value.map((item) => {
    const record = requireRecord(item, "function argument");
    rejectUnknown(record, ["name", "type"], "function argument");
    return {
      name: requireString(record.name, "argument name"),
      type: requireString(record.type, "argument type"),
    };
  });
}

function parseVolatility(value: unknown): "volatile" | "stable" | "immutable" | undefined {
  if (value === undefined) return undefined;
  const text = requireString(value, "volatility");
  if (text !== "volatile" && text !== "stable" && text !== "immutable") {
    catalogError("OKM1020", `Volatility ${text} is not supported.`);
  }
  return text;
}

function parseSecurity(value: unknown): "invoker" | "definer" | undefined {
  if (value === undefined) return undefined;
  const text = requireString(value, "security");
  if (text !== "invoker" && text !== "definer") {
    catalogError("OKM1020", `Security ${text} is not supported.`);
  }
  return text;
}

function parseTrigger(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "trigger") {
    catalogError("OKM1020", `Trigger object identity is ${identity.kind}, not a trigger.`);
  }
  rejectUnknown(
    definition,
    ["calls", "events", "level", "timing", "updateOf", "when"],
    "trigger definition",
  );
  const timing = requireString(definition.timing, "trigger timing");
  if (timing !== "before" && timing !== "after" && timing !== "instead") {
    catalogError("OKM1020", `Trigger timing ${timing} is not supported.`);
  }
  const level = requireString(definition.level, "trigger level");
  if (level !== "row" && level !== "statement") {
    catalogError("OKM1020", `Trigger level ${level} is not supported.`);
  }
  const calls = requireRecord(definition.calls, "trigger call");
  rejectUnknown(calls, ["argTypes", "name", "namespace"], "trigger call");
  return triggerObject({
    parent: identity.parent,
    name: identity.name,
    timing,
    events: requireStrings(definition.events, "trigger events").map(parseEvent),
    level,
    calls: {
      namespace: parseNamespace(calls.namespace),
      name: requireString(calls.name, "trigger function"),
      argTypes: requireStrings(calls.argTypes, "trigger argument types"),
    },
    owner,
    provenance,
    dependencies,
    ...(definition.updateOf !== undefined
      ? { updateOf: requireStrings(definition.updateOf, "update of") }
      : {}),
    ...(definition.when !== undefined ? { when: requireString(definition.when, "when") } : {}),
  });
}

function parseView(
  kind: "view" | "materializedView",
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== kind) {
    catalogError("OKM1020", `View object identity is ${identity.kind}, not a ${kind}.`);
  }
  const fields =
    kind === "view" ? ["columns", "query", "securityInvoker"] : ["columns", "query", "refresh"];
  rejectUnknown(definition, fields, "view definition");
  const columns = parseViewColumns(definition.columns);
  const query = requireString(definition.query, "view query");
  const refresh = definition.refresh;
  if (refresh !== undefined && refresh !== "concurrently") {
    catalogError("OKM1020", `Materialized view ${identity.name} refresh is not supported.`);
  }
  const input = {
    namespace: identity.namespace,
    name: identity.name,
    columns,
    query,
    owner,
    provenance,
    dependencies,
  };
  if (kind === "materializedView") {
    return materializedViewObject({
      ...input,
      ...(refresh === "concurrently" ? { refresh: "concurrently" as const } : {}),
    });
  }
  if (definition.securityInvoker !== undefined && definition.securityInvoker !== true) {
    catalogError("OKM1020", `View ${identity.name} securityInvoker must be true when set.`);
  }
  return viewObject({
    ...input,
    ...(definition.securityInvoker === true ? { securityInvoker: true as const } : {}),
  });
}

function parsePolicy(record: Record<string, unknown>): CatalogObject {
  const identity = parseIdentity(record.identity);
  if (identity.kind !== "policy") {
    catalogError("OKM1020", `Policy object identity is ${identity.kind}, not a policy.`);
  }
  const owner = parseOwner(record.owner);
  const provenance = parseProvenance(record.provenance);
  const dependencies = parseDependencies(record.dependencies);
  const definition = requireRecord(record.definition, "definition");
  rejectUnknown(definition, ["command", "expression", "force"], "policy definition");
  const command = requireString(definition.command, "policy command");
  if (command !== "all" && command !== "select") {
    catalogError("OKM1020", `Policy ${identity.name} command is not supported.`);
  }
  return policyObject({
    parent: identity.parent,
    name: identity.name,
    command,
    expression: requireString(definition.expression, "policy expression"),
    force: requireBoolean(definition.force, "policy force"),
    owner,
    provenance,
    dependencies,
  });
}

function parseViewColumns(value: unknown): { readonly name: string; readonly dataType: string }[] {
  if (!Array.isArray(value)) catalogError("OKM1020", "View columns must be a list.");
  return value.map((item) => {
    const record = requireRecord(item, "view column");
    rejectUnknown(record, ["dataType", "name"], "view column");
    return {
      name: requireString(record.name, "view column"),
      dataType: requireString(record.dataType, "view column type"),
    };
  });
}

function parseEvent(value: string): "insert" | "update" | "delete" | "truncate" {
  if (value !== "insert" && value !== "update" && value !== "delete" && value !== "truncate") {
    catalogError("OKM1020", `Trigger event ${value} is not supported.`);
  }
  return value;
}

function parseExtension(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): ExtensionObject {
  if (identity.kind !== "extension") {
    catalogError("OKM1020", `Extension object identity is ${identity.kind}, not an extension.`);
  }
  rejectUnknown(definition, ["relocatable", "schema", "version"], "extension definition");
  return extensionObject({
    name: identity.name,
    schema: requireString(definition.schema, "extension schema"),
    relocatable: requireBoolean(definition.relocatable, "relocatable"),
    ...(definition.version !== undefined
      ? { version: requireString(definition.version, "extension version") }
      : {}),
    owner,
    provenance,
    dependencies,
  });
}

function parseIdentity(value: unknown): ObjectIdentity {
  const record = requireRecord(value, "identity");
  const kind = requireString(record.kind, "identity kind");
  switch (kind) {
    case "table":
    case "view":
    case "materializedView":
    case "sequence":
    case "type":
      rejectUnknown(record, ["kind", "name", "namespace"], "identity");
      return {
        kind,
        name: requireString(record.name, "name"),
        namespace: parseNamespace(record.namespace),
      };
    case "column":
    case "index":
    case "constraint":
    case "trigger":
    case "policy":
      rejectUnknown(record, ["kind", "name", "parent"], "identity");
      return {
        kind,
        name: requireString(record.name, "name"),
        parent: parseRef(record.parent),
      };
    case "function":
      rejectUnknown(record, ["argTypes", "kind", "name", "namespace"], "identity");
      return {
        kind,
        name: requireString(record.name, "name"),
        namespace: parseNamespace(record.namespace),
        argTypes: requireStrings(record.argTypes, "argument types"),
      };
    case "grant":
      rejectUnknown(record, ["kind", "object", "privilege", "role"], "identity");
      return {
        kind,
        role: requireString(record.role, "role"),
        privilege: requireString(record.privilege, "privilege"),
        object: parseGrantObject(record.object),
      };
    case "defaultPrivilege":
      rejectUnknown(
        record,
        ["forRole", "grantee", "kind", "namespace", "objectKind", "privilege"],
        "identity",
      );
      return {
        kind,
        forRole: requireString(record.forRole, "forRole"),
        grantee: requireString(record.grantee, "grantee"),
        namespace: parseNamespace(record.namespace),
        objectKind: requireString(record.objectKind, "object kind"),
        privilege: requireString(record.privilege, "privilege"),
      };
    case "role":
    case "extension":
      rejectUnknown(record, ["kind", "name"], "identity");
      return { kind, name: requireString(record.name, "name") };
    default:
      catalogError("OKM1020", `Identity kind ${kind} is not a catalog identity.`);
  }
}

function parseNamespace(value: unknown): Namespace {
  const record = requireRecord(value, "namespace");
  const form = requireString(record.form, "namespace form");
  if (form === "static") {
    rejectUnknown(record, ["form", "name"], "namespace");
    return staticNamespace(requireString(record.name, "namespace"));
  }
  if (form === "template") {
    rejectUnknown(record, ["form", "pattern"], "namespace");
    return templateNamespace(requireString(record.pattern, "namespace template"));
  }
  catalogError("OKM1020", `Namespace form ${form} must be static or template.`);
}

function parseRef(value: unknown): ObjectRef {
  const record = requireRecord(value, "parent");
  rejectUnknown(record, ["name", "namespace"], "parent");
  return {
    name: requireString(record.name, "parent name"),
    namespace: parseNamespace(record.namespace),
  };
}

function parseGrantObject(value: unknown): {
  readonly kind: "table" | "view" | "materializedView" | "sequence" | "function" | "namespace";
  readonly namespace: Namespace;
  readonly name: string;
} {
  const record = requireRecord(value, "grant object");
  rejectUnknown(record, ["kind", "name", "namespace"], "grant object");
  const kind = requireString(record.kind, "grant object kind");
  if (
    kind !== "table" &&
    kind !== "view" &&
    kind !== "materializedView" &&
    kind !== "sequence" &&
    kind !== "function" &&
    kind !== "namespace"
  ) {
    catalogError(
      "OKM1020",
      `Grant object kind ${kind} must be table, view, materializedView, sequence, function, or namespace.`,
    );
  }
  return {
    kind,
    name: requireString(record.name, "grant object name"),
    namespace: parseNamespace(record.namespace),
  };
}

function parseRole(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "role") {
    catalogError("OKM1020", `Role object identity is ${identity.kind}, not a role.`);
  }
  rejectUnknown(definition, ["inherit", "login"], "role definition");
  return roleObject({
    name: identity.name,
    login: requireBoolean(definition.login, "login"),
    inherit: requireBoolean(definition.inherit, "inherit"),
    owner,
    provenance,
    dependencies,
  });
}

function parseGrant(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "grant") {
    catalogError("OKM1020", `Grant object identity is ${identity.kind}, not a grant.`);
  }
  rejectUnknown(definition, [], "grant definition");
  return grantObject({
    role: identity.role,
    object: identity.object,
    privilege: identity.privilege,
    owner,
    provenance,
    dependencies,
  });
}

function parseDefaultPrivilege(
  identity: ObjectIdentity,
  definition: Record<string, unknown>,
  owner: Owner,
  provenance: Provenance,
  dependencies: readonly ObjectIdentity[],
): CatalogObject {
  if (identity.kind !== "defaultPrivilege") {
    catalogError(
      "OKM1020",
      `Default privilege object identity is ${identity.kind}, not a default privilege.`,
    );
  }
  rejectUnknown(definition, [], "default privilege definition");
  return defaultPrivilegeObject({
    forRole: identity.forRole,
    namespace: identity.namespace,
    objectKind: identity.objectKind,
    grantee: identity.grantee,
    privilege: identity.privilege,
    owner,
    provenance,
    dependencies,
  });
}

function parsePartition(value: unknown): {
  readonly method: "range" | "list" | "hash";
  readonly columns: readonly string[];
} {
  const record = requireRecord(value, "partition");
  rejectUnknown(record, ["columns", "method"], "partition");
  const method = requireString(record.method, "partition method");
  if (method !== "range" && method !== "list" && method !== "hash") {
    catalogError("OKM1020", `Partition method ${method} must be range, list, or hash.`);
  }
  return { method, columns: requireStrings(record.columns, "partition columns") };
}

function parseReferences(value: unknown): {
  readonly parent: ObjectRef;
  readonly columns: readonly string[];
  readonly onDelete?: ReferentialAction;
  readonly onUpdate?: ReferentialAction;
} {
  const record = requireRecord(value, "references");
  rejectUnknown(record, ["columns", "onDelete", "onUpdate", "parent"], "references");
  const onDelete = parseAction(record.onDelete, "onDelete");
  const onUpdate = parseAction(record.onUpdate, "onUpdate");
  return {
    parent: parseRef(record.parent),
    columns: requireStrings(record.columns, "referenced columns"),
    ...(onDelete !== undefined ? { onDelete } : {}),
    ...(onUpdate !== undefined ? { onUpdate } : {}),
  };
}

function parseAction(value: unknown, role: string): ReferentialAction | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = requireString(value, role);
  const action = referentialAction(text);
  if (action === undefined) {
    catalogError(
      "OKM1020",
      `Referential action ${text} is not a catalog action. Accepted actions: cascade, no action, restrict, set default, set null.`,
    );
  }
  return action;
}

function parseAlways(value: unknown): { readonly always: boolean } {
  const record = requireRecord(value, "identity");
  rejectUnknown(record, ["always"], "identity");
  return { always: requireBoolean(record.always, "always") };
}

function parseGenerated(value: unknown): { readonly stored: boolean; readonly expression: string } {
  const record = requireRecord(value, "generated");
  rejectUnknown(record, ["expression", "stored"], "generated");
  return {
    stored: requireBoolean(record.stored, "stored"),
    expression: requireString(record.expression, "generated expression"),
  };
}

function parseOwner(value: unknown): Owner {
  const owner = requireString(value, "owner");
  if (!isOwner(owner)) {
    catalogError("OKM1020", `Owner ${owner} must be managed, external, or ignored.`);
  }
  return owner;
}

function parseProvenance(value: unknown): Provenance {
  const record = requireRecord(value, "provenance");
  rejectUnknown(record, ["name", "origin"], "provenance");
  const origin = requireString(record.origin, "provenance origin");
  const name = requireString(record.name, "provenance name");
  if (origin !== "file" && origin !== "trait" && origin !== "extension") {
    catalogError("OKM1020", `Provenance origin ${origin} must be file, trait, or extension.`);
  }
  return { origin, name };
}

function parseDependencies(value: unknown): readonly ObjectIdentity[] {
  if (!Array.isArray(value)) {
    catalogError("OKM1020", "Dependencies must be an array of targets.");
  }
  return value.map((item) => {
    const record = requireRecord(item, "dependency");
    rejectUnknown(record, ["target"], "dependency");
    return parseIdentity(record.target);
  });
}

function isBuiltKind(kind: string): kind is Exclude<CatalogObject["kind"], "policy"> {
  return (
    kind === "extension" ||
    kind === "function" ||
    kind === "trigger" ||
    kind === "view" ||
    kind === "materializedView" ||
    kind === "role" ||
    kind === "grant" ||
    kind === "defaultPrivilege" ||
    (BUILT_KINDS as readonly string[]).includes(kind)
  );
}

function isOwner(value: string): value is Owner {
  return (OWNERS as readonly string[]).includes(value);
}

function requireRecord(value: unknown, role: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    catalogError("OKM1020", `${role} is not an object.`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, role: string): string {
  if (typeof value !== "string") {
    catalogError("OKM1020", `${role} is not a string.`);
  }
  return value;
}

function requireBoolean(value: unknown, role: string): boolean {
  if (typeof value !== "boolean") {
    catalogError("OKM1020", `${role} is not a boolean.`);
  }
  return value;
}

function requireStrings(value: unknown, role: string): readonly string[] {
  if (!Array.isArray(value)) {
    catalogError("OKM1020", `${role} is not an array.`);
  }
  return value.map((item) => requireString(item, role));
}

function rejectUnknown(
  record: Record<string, unknown>,
  allowed: readonly string[],
  role: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      catalogError("OKM1020", `${role} has unexpected field ${key}.`);
    }
  }
}

function assertNever(value: never): never {
  return catalogError("OKM1020", `Unexpected catalog object ${JSON.stringify(value)}.`);
}

function assertNeverKind(value: never): never {
  return catalogError("OKM1020", `Unexpected kind ${JSON.stringify(value)}.`);
}
