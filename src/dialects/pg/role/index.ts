/**
 * `roles: { migration, app }`.
 *
 * The object contributes role, grant, and default-privilege records. `schema()`
 * does not import this module. Tooling calls {@link attachRoles} when the
 * config names roles.
 */

import { catalog } from "../../../contracts/catalog/build.js";
import { staticNamespace } from "../../../contracts/catalog/identity.js";
import {
  defaultPrivilegeObject,
  grantObject,
  roleObject,
} from "../../../contracts/catalog/privilege.js";
import type {
  Catalog,
  CatalogObject,
  GrantObjectRef,
  ObjectIdentity,
  Provenance,
} from "../../../contracts/catalog/types.js";
import { OkmError } from "../../../contracts/error.js";

/** A role the plan creates and alters. It is never dropped. */
export type ManagedRole = {
  readonly name: string;
  /** `LOGIN` when true. The default is `NOLOGIN`. */
  readonly login?: boolean;
  /** `INHERIT` when not `false`. */
  readonly inherit?: boolean;
};

/**
 * Roles named by `defineConfig`.
 *
 * A string is external: it must already exist. A name listed in `managed` is
 * created when `pg_roles` does not have it.
 */
export type RolesInput = {
  /** Role that runs migrations. */
  readonly migration: string;
  /** Role the application connects as. */
  readonly app: string;
  /** Roles this catalog creates and alters. */
  readonly managed?: readonly ManagedRole[];
};

const PROVENANCE: Provenance = { origin: "file", name: "roles" };

const RELATION = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
const READ = ["SELECT"] as const;
const ROUTINE = ["EXECUTE"] as const;
const SEQUENCE = ["USAGE", "SELECT"] as const;

/**
 * Adds role, grant, and default-privilege objects to a catalog.
 *
 * Grants and default privileges are for {@link RolesInput.app} on every
 * managed table, view, materialized view, sequence, and function. Fine-grained
 * grants are not accepted here.
 *
 * @param source - Catalog from `schema()`
 * @param input - Migration role, application role, and managed roles
 * @returns A catalog that includes those objects
 */
export function attachRoles(source: Catalog, input: RolesInput): Catalog {
  return catalog([...source.objects, ...contributeRoles(input, source.objects)]);
}

/**
 * Catalog records for one `roles` configuration.
 *
 * @param input - Migration role, application role, and managed roles
 * @param built - Objects already in the catalog
 * @returns Role, grant, and default-privilege records
 */
export function contributeRoles(
  input: RolesInput,
  built: readonly CatalogObject[],
): readonly CatalogObject[] {
  const migration = requireName(input.migration, "migration");
  const app = requireName(input.app, "app");
  const managed = new Map<string, ManagedRole>();
  for (const role of input.managed ?? []) {
    const name = requireName(role.name, "managed role");
    managed.set(name, role);
  }
  const objects: CatalogObject[] = [];
  const names = new Set<string>([migration, app, ...managed.keys()]);
  for (const name of [...names].sort()) {
    const declaration = managed.get(name);
    objects.push(
      roleObject({
        name,
        owner: declaration === undefined ? "external" : "managed",
        provenance: PROVENANCE,
        ...(declaration === undefined
          ? { login: false, inherit: true }
          : {
              ...(declaration.login !== undefined ? { login: declaration.login } : {}),
              ...(declaration.inherit !== undefined ? { inherit: declaration.inherit } : {}),
            }),
      }),
    );
  }
  const roleIdentity = (name: string): ObjectIdentity => ({ kind: "role", name });
  const namespaces = new Set<string>();
  for (const object of built) {
    if (object.owner === "ignored") continue;
    const ref = grantRef(object);
    if (ref === undefined) continue;
    if (ref.namespace.form === "static") namespaces.add(ref.namespace.name);
    const privileges = privilegesFor(ref.kind);
    for (const privilege of privileges) {
      objects.push(
        grantObject({
          role: app,
          object: ref,
          privilege,
          provenance: PROVENANCE,
          dependencies: [roleIdentity(app), objectIdentity(object)],
        }),
      );
    }
  }
  const schemas = namespaces.size === 0 ? ["public"] : [...namespaces].sort();
  for (const name of schemas) {
    const namespace = staticNamespace(name);
    for (const [objectKind, privileges] of [
      ["table", RELATION],
      ["function", ROUTINE],
      ["sequence", SEQUENCE],
    ] as const) {
      for (const privilege of privileges) {
        objects.push(
          defaultPrivilegeObject({
            forRole: migration,
            namespace,
            objectKind,
            grantee: app,
            privilege,
            provenance: PROVENANCE,
            dependencies: [roleIdentity(migration), roleIdentity(app)],
          }),
        );
      }
    }
  }
  return objects;
}

function requireName(name: string, role: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new OkmError("invalid", `roles.${role} needs a name.`, {
      fix: { summary: "Set roles.migration and roles.app to role names." },
    });
  }
  return name;
}

function grantRef(object: CatalogObject): GrantObjectRef | undefined {
  if (object.kind === "table" || object.kind === "view" || object.kind === "materializedView") {
    return { kind: object.kind, namespace: object.identity.namespace, name: object.identity.name };
  }
  if (object.kind === "sequence") {
    return { kind: "sequence", namespace: object.identity.namespace, name: object.identity.name };
  }
  if (object.kind === "function") {
    return {
      kind: "function",
      namespace: object.identity.namespace,
      name: `${object.identity.name}(${object.identity.argTypes.join(",")})`,
    };
  }
  return undefined;
}

function privilegesFor(kind: GrantObjectRef["kind"]): readonly string[] {
  if (kind === "function") return ROUTINE;
  if (kind === "sequence") return SEQUENCE;
  if (kind === "materializedView") return READ;
  if (kind === "namespace") return [];
  return RELATION;
}

function objectIdentity(object: CatalogObject): ObjectIdentity {
  return object.identity;
}
