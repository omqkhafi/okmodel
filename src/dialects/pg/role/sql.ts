/**
 * SQL for roles, grants, and default privileges.
 *
 * The plan calls these. `SET ROLE` is not one of them: the runner issues it
 * once, outside the plan (D119).
 */

import { identityKey } from "../../../contracts/catalog/identity.js";
import { OkmError } from "../../../contracts/error.js";
import type {
  CatalogObject,
  DefaultPrivilegeObject,
  GrantObject,
  GrantObjectRef,
  RoleObject,
} from "../../../contracts/catalog/types.js";
import { qualify, quoteIdent } from "../ddl.js";

/** Statements the planner inserts around the rest of the catalog. */
export type PrivilegeSql = {
  /** Revokes, run while the objects still exist. */
  readonly revoke: readonly string[];
  /** Role creates, role alters, and default privileges. Before new tables. */
  readonly prepare: readonly string[];
  /** Grants on objects that exist, or that this plan creates first. */
  readonly grant: readonly string[];
};

const PRIVILEGE = /^(select|insert|update|delete|execute|usage)$/;

/**
 * Diffs role, grant, and default-privilege objects into SQL.
 *
 * A role is created only when it is managed and absent. It is altered only
 * when both sides are managed. It is never dropped. Grants and default
 * privileges are revoked and granted. None of the statements use
 * `IF NOT EXISTS`.
 *
 * @param before - Previous catalog objects
 * @param after - Next catalog objects
 * @param schema - Concrete schema name
 * @returns Statements in three groups
 */
export function privilegeSql(
  before: readonly CatalogObject[],
  after: readonly CatalogObject[],
  schema: string,
): PrivilegeSql {
  const beforeBy = index(before);
  const afterBy = index(after);
  const revoke: string[] = [];
  const roles: string[] = [];
  const defaults: string[] = [];
  const grant: string[] = [];
  for (const [key, object] of beforeBy) {
    if (afterBy.has(key)) continue;
    if (object.kind === "grant") revoke.push(grantStatement(object, schema, true));
    if (object.kind === "defaultPrivilege") revoke.push(defaultStatement(object, true));
  }
  for (const [key, object] of afterBy) {
    const previous = beforeBy.get(key);
    if (object.kind === "role") {
      if (object.owner !== "managed") continue;
      if (previous === undefined) {
        roles.push(createRoleSql(object));
        continue;
      }
      if (previous.kind !== "role" || previous.owner !== "managed") continue;
      if (
        previous.definition.login !== object.definition.login ||
        previous.definition.inherit !== object.definition.inherit
      ) {
        roles.push(alterRoleSql(object));
      }
      continue;
    }
    if (previous !== undefined) continue;
    if (object.kind === "defaultPrivilege") defaults.push(defaultStatement(object, false));
    if (object.kind === "grant") grant.push(grantStatement(object, schema, false));
  }
  return { revoke, prepare: [...roles, ...defaults], grant };
}

/**
 * Role name in `create role`, when the statement is one.
 *
 * @param sql - One plan statement
 * @returns The role, or `undefined` when the statement is not `CREATE ROLE`
 */
export function createdRoleName(sql: string): string | undefined {
  const match = /^\s*create\s+role\s+(?:"([^"]+)"|([A-Za-z_][\w$]*))/i.exec(sql);
  const quoted = match?.[1];
  if (quoted !== undefined) return quoted.replaceAll('""', '"');
  return match?.[2];
}

/**
 * Reports whether a statement creates or alters a role.
 *
 * @param sql - One plan statement
 * @returns `true` for `CREATE ROLE` and `ALTER ROLE`
 */
export function changesRole(sql: string): boolean {
  return /^\s*(create|alter)\s+role\b/i.test(sql);
}

function index(objects: readonly CatalogObject[]): Map<string, CatalogObject> {
  const by = new Map<string, CatalogObject>();
  for (const object of objects) {
    if (object.kind !== "role" && object.kind !== "grant" && object.kind !== "defaultPrivilege") {
      continue;
    }
    by.set(identityKey(object.identity), object);
  }
  return by;
}

function createRoleSql(object: RoleObject): string {
  return `create role ${quoteIdent(object.identity.name)} with nosuperuser nocreatedb nocreaterole ${inherit(object)} ${login(object)}`;
}

function alterRoleSql(object: RoleObject): string {
  return `alter role ${quoteIdent(object.identity.name)} with ${inherit(object)} ${login(object)}`;
}

function login(object: RoleObject): string {
  return object.definition.login ? "login" : "nologin";
}

function inherit(object: RoleObject): string {
  return object.definition.inherit ? "inherit" : "noinherit";
}

function grantStatement(object: GrantObject, schema: string, revoke: boolean): string {
  const privilege = object.identity.privilege.toLowerCase();
  assertPrivilege(privilege);
  const verb = revoke ? "revoke" : "grant";
  const direction = revoke ? "from" : "to";
  return `${verb} ${privilege} on ${grantTarget(object.identity.object, schema)} ${direction} ${quoteIdent(object.identity.role)}`;
}

function defaultStatement(object: DefaultPrivilegeObject, revoke: boolean): string {
  const privilege = object.identity.privilege.toLowerCase();
  assertPrivilege(privilege);
  const verb = revoke ? "revoke" : "grant";
  const direction = revoke ? "from" : "to";
  const namespace =
    object.identity.namespace.form === "static" ? object.identity.namespace.name : "public";
  return `alter default privileges for role ${quoteIdent(object.identity.forRole)} in schema ${quoteIdent(namespace)} ${verb} ${privilege} on ${objectKindSql(object.identity.objectKind)} ${direction} ${quoteIdent(object.identity.grantee)}`;
}

function grantTarget(object: GrantObjectRef, schema: string): string {
  const name = object.namespace.form === "static" ? object.namespace.name : schema;
  if (object.kind === "sequence") return `sequence ${qualify(name, object.name)}`;
  if (object.kind === "function") return functionTarget(object.name, name);
  if (object.kind === "namespace") return `schema ${quoteIdent(object.name)}`;
  return `table ${qualify(name, object.name)}`;
}

function functionTarget(name: string, schema: string): string {
  const open = name.lastIndexOf("(");
  if (open < 0 || !name.endsWith(")")) return `function ${qualify(schema, name)}()`;
  const fn = name.slice(0, open);
  const args = name.slice(open + 1, -1);
  return `function ${qualify(schema, fn)}(${args})`;
}

function objectKindSql(kind: string): string {
  if (kind === "function") return "functions";
  if (kind === "sequence") return "sequences";
  return "tables";
}

function assertPrivilege(privilege: string): void {
  if (!PRIVILEGE.test(privilege)) {
    throw new OkmError("invalid", `Privilege ${privilege} is not emitted.`, {
      fix: {
        summary: "Grants in this version are select, insert, update, delete, execute, and usage.",
      },
    });
  }
}
