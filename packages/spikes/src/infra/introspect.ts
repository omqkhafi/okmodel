/**
 * Reads roles, grants, default privileges, and extension inventory.
 *
 * Table introspection stays in the catalog spike. This module reads the
 * catalogs that spike does not: `pg_roles`, `aclexplode`, and `pg_default_acl`.
 */

import { diffNormalized, normalizeCatalogObject } from "../catalog/normalize.js";
import {
  assertPrivilege,
  defaultPrivilegeIdentityName,
  grantIdentityName,
  type CatalogObject,
  type DefaultPrivilegeObjectType,
  type GrantObjectKind,
  type GrantPrivilege,
  type NamespaceName,
  type Owner,
} from "../catalog/object.js";
import { quoteLiteral } from "../catalog/sql.js";
import { type SqlRunner } from "../catalog/introspect.js";

const provenance = { source: "introspect" };

/**
 * One extension the server can install, including every shipped version.
 */
export type ExtensionOffer = {
  readonly name: string;
  readonly defaultVersion: string;
  readonly installedVersion: string;
  readonly versions: readonly string[];
  readonly relocatable: boolean;
  readonly schema: string;
};

/**
 * Extension-owned objects, counted from `pg_depend` with deptype `e`.
 */
export type ExtensionMembers = {
  readonly functions: number;
  readonly types: number;
  readonly operators: number;
  readonly functionNames: readonly string[];
};

/**
 * Reads the roles, grants, and default privileges this catalog declared.
 *
 * `aclexplode` also returns the table owner's privileges. Those rows are
 * dropped unless the grantee is one of `roles`. Ownership is not in
 * `pg_roles`, so the caller passes it back in.
 *
 * @param runner - Database connection
 * @param namespace - Logical namespace, matched to `schema` by name
 * @param schema - Concrete schema
 * @param roles - Role names to read
 * @param ownerFor - Ownership to stamp on each role. Grants stay `managed`
 * @returns Catalog objects in the shared envelope
 */
export async function introspectPrivileges(
  runner: SqlRunner,
  namespace: NamespaceName,
  schema: string,
  roles: readonly string[],
  ownerFor: (name: string) => Owner,
): Promise<readonly CatalogObject[]> {
  if (roles.length === 0) return [];
  const roleList = roles.map((name) => quoteLiteral(name)).join(", ");
  const schemaLiteral = quoteLiteral(schema);
  const objects: CatalogObject[] = [];
  const roleRows = await runner.query(`
    select rolname as name, rolcanlogin as login, rolinherit as inherit
    from pg_roles
    where rolname in (${roleList})
  `);
  for (const row of roleRows) {
    const name = text(row, "name");
    objects.push({
      kind: "role",
      identity: { kind: "role", name },
      owner: ownerFor(name),
      definition: {
        login: flag(row, "login") === "true",
        inherit: flag(row, "inherit") === "true",
      },
      dependencies: [],
      provenance,
    });
  }
  const grantRows = await runner.query(`
    select n.nspname as schema, c.relname as parent,
      case when c.relkind = 'S' then 'sequence' else 'table' end as object_kind,
      r.rolname as role, a.privilege_type as privilege, a.is_grantable as grantable
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    join pg_roles r on r.oid = a.grantee
    where n.nspname = ${schemaLiteral}
      and c.relkind in ('r', 'p', 'S')
      and r.rolname in (${roleList})
    union all
    select n.nspname as schema, '' as parent, 'schema' as object_kind,
      r.rolname as role, a.privilege_type as privilege, a.is_grantable as grantable
    from pg_namespace n
    cross join lateral aclexplode(n.nspacl) a
    join pg_roles r on r.oid = a.grantee
    where n.nspname = ${schemaLiteral}
      and r.rolname in (${roleList})
  `);
  for (const row of grantRows) {
    const privilege = privilegeOrSkip(text(row, "privilege"));
    if (privilege === undefined) continue;
    const objectKind = objectKindOf(text(row, "object_kind"));
    const role = text(row, "role");
    const parent = text(row, "parent");
    objects.push({
      kind: "grant",
      identity: {
        kind: "grant",
        namespace,
        parent,
        name: grantIdentityName(role, objectKind, privilege),
        role,
        objectKind,
        privilege,
      },
      owner: "managed",
      definition: { grantable: flag(row, "grantable") === "true" },
      dependencies: [],
      provenance,
    });
  }
  const defaultRows = await runner.query(`
    select pg_get_userbyid(d.defaclrole) as for_role, n.nspname as schema,
      d.defaclobjtype as object_type, r.rolname as role,
      a.privilege_type as privilege, a.is_grantable as grantable
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
    join pg_roles r on r.oid = a.grantee
    where n.nspname = ${schemaLiteral}
      and r.rolname in (${roleList})
  `);
  for (const row of defaultRows) {
    const privilege = privilegeOrSkip(text(row, "privilege"));
    const objectType = defaultObjectType(text(row, "object_type"));
    if (privilege === undefined || objectType === undefined) continue;
    const forRole = text(row, "for_role");
    const role = text(row, "role");
    objects.push({
      kind: "default_privilege",
      identity: {
        kind: "default_privilege",
        namespace,
        name: defaultPrivilegeIdentityName(forRole, objectType, role, privilege),
        forRole,
        role,
        objectType,
        privilege,
      },
      owner: "managed",
      definition: { grantable: flag(row, "grantable") === "true" },
      dependencies: [],
      provenance,
    });
  }
  return objects;
}

/**
 * Structural mismatches between a privilege catalog and an introspection.
 *
 * Owner and provenance are ignored. Identity and definition are not.
 *
 * @param expected - Catalog that was applied
 * @param actual - Objects read back
 * @returns Empty when the two sides match
 */
export function privilegeMismatches(
  expected: readonly CatalogObject[],
  actual: readonly CatalogObject[],
): readonly string[] {
  const kinds = new Set(["role", "grant", "default_privilege"]);
  return diffNormalized(
    expected
      .filter((object) => kinds.has(object.kind))
      .map((object) => normalizeCatalogObject(object)),
    actual
      .filter((object) => kinds.has(object.kind))
      .map((object) => normalizeCatalogObject(object)),
  );
}

/**
 * Lists every extension the connected server offers.
 *
 * Relocatability and the default schema come from the default version in
 * `pg_available_extension_versions`.
 *
 * @param runner - Database connection
 * @returns One row per extension name
 */
export async function introspectExtensions(runner: SqlRunner): Promise<readonly ExtensionOffer[]> {
  const rows = await runner.query(`
    select e.name, e.default_version, coalesce(e.installed_version, '') as installed_version,
      v.version, v.relocatable, coalesce(v.schema, '') as schema
    from pg_available_extensions e
    join pg_available_extension_versions v on v.name = e.name
    order by e.name, v.version
  `);
  const byName = new Map<string, MutableOffer>();
  for (const row of rows) {
    const name = text(row, "name");
    const version = text(row, "version");
    const existing = byName.get(name);
    if (existing === undefined) {
      byName.set(name, {
        name,
        defaultVersion: text(row, "default_version"),
        installedVersion: text(row, "installed_version"),
        versions: [version],
        relocatable: flag(row, "relocatable") === "true",
        schema: text(row, "schema"),
      });
      continue;
    }
    existing.versions.push(version);
    if (version === existing.defaultVersion) {
      existing.relocatable = flag(row, "relocatable") === "true";
      existing.schema = text(row, "schema");
    }
  }
  return [...byName.values()]
    .map((offer) => ({ ...offer, versions: [...offer.versions] }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Times {@link introspectExtensions}.
 *
 * @param runner - Database connection
 * @returns Milliseconds and the offer count
 */
export async function timeExtensionIntrospection(
  runner: SqlRunner,
): Promise<{ readonly ms: number; readonly extensions: number }> {
  const started = performance.now();
  const offers = await introspectExtensions(runner);
  return { ms: performance.now() - started, extensions: offers.length };
}

/**
 * Counts objects an extension owns in one schema.
 *
 * @param runner - Database connection
 * @param schema - Schema the extension was installed into
 * @param extension - Extension name
 * @returns Counts and the function names, which the user-object diff must omit
 */
export async function extensionMembers(
  runner: SqlRunner,
  schema: string,
  extension: string,
): Promise<ExtensionMembers> {
  const schemaLiteral = quoteLiteral(schema);
  const extensionLiteral = quoteLiteral(extension);
  const functions = await runner.query(`
    select p.proname as name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_depend d on d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
    join pg_extension e on e.oid = d.refobjid
    where n.nspname = ${schemaLiteral} and e.extname = ${extensionLiteral}
  `);
  const types = await runner.query(`
    select count(*)::text as count
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    join pg_depend d on d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e'
    join pg_extension e on e.oid = d.refobjid
    where n.nspname = ${schemaLiteral} and e.extname = ${extensionLiteral}
  `);
  const operators = await runner.query(`
    select count(*)::text as count
    from pg_operator o
    join pg_namespace n on n.oid = o.oprnamespace
    join pg_depend d on d.classid = 'pg_operator'::regclass and d.objid = o.oid and d.deptype = 'e'
    join pg_extension e on e.oid = d.refobjid
    where n.nspname = ${schemaLiteral} and e.extname = ${extensionLiteral}
  `);
  return {
    functions: functions.length,
    types: Number(text(types[0] ?? {}, "count")),
    operators: Number(text(operators[0] ?? {}, "count")),
    functionNames: functions.map((row) => text(row, "name")),
  };
}

/**
 * Update paths Postgres will actually apply for one extension.
 *
 * @param runner - Database connection
 * @param extension - Extension name
 * @returns Source, target, and path. An empty path means no upgrade
 */
export async function extensionUpdatePaths(
  runner: SqlRunner,
  extension: string,
): Promise<readonly { readonly source: string; readonly target: string; readonly path: string }[]> {
  const rows = await runner.query(`
    select coalesce(source, '') as source, coalesce(target, '') as target, coalesce(path, '') as path
    from pg_extension_update_paths(${quoteLiteral(extension)})
  `);
  return rows.map((row) => ({
    source: text(row, "source"),
    target: text(row, "target"),
    path: text(row, "path"),
  }));
}

type MutableOffer = {
  name: string;
  defaultVersion: string;
  installedVersion: string;
  versions: string[];
  relocatable: boolean;
  schema: string;
};

function privilegeOrSkip(value: string): GrantPrivilege | undefined {
  try {
    return assertPrivilege(value.toLowerCase());
  } catch {
    return undefined;
  }
}

function objectKindOf(value: string): GrantObjectKind {
  if (value === "schema" || value === "sequence" || value === "table") return value;
  return "table";
}

function defaultObjectType(value: string): DefaultPrivilegeObjectType | undefined {
  switch (value) {
    case "r":
      return "tables";
    case "S":
      return "sequences";
    case "f":
      return "functions";
    case "T":
      return "types";
    default:
      return undefined;
  }
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  return "";
}

function flag(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === true || value === "t" || value === "true") return "true";
  if (value === false || value === "f" || value === "false") return "false";
  return "";
}
