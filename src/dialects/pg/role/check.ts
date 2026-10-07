/**
 * Role checks for `okm doctor` and apply preflight.
 *
 * Both run before any catalog statement. `connect()` does not call them.
 */

import type { DriverPool } from "../../../contracts/driver.js";
import { OkmError } from "../../../contracts/error.js";
import type { CatalogObject, GrantObject } from "../../../contracts/catalog/types.js";
import { FUNCTION_ARG_TYPES } from "../introspect.js";
import type { RolesInput } from "./index.js";

/** A pool or a reserved connection. Both can run one statement. */
type Runner = Pick<DriverPool, "execute">;

/**
 * Checks named roles, `CREATEROLE`, and the application role's privileges.
 *
 * A missing external role is reported. A managed role that is absent is not:
 * the plan creates it. OKM1825 is raised only when the object exists and the
 * privilege is missing.
 *
 * @param runner - Database connection
 * @param roles - `defineConfig({ roles })`
 * @param objects - Catalog, including grants
 */
export async function assertRoleHealth(
  runner: Runner,
  roles: RolesInput,
  objects: readonly CatalogObject[],
): Promise<void> {
  const managed = new Set((roles.managed ?? []).map((role) => role.name));
  const named = [roles.migration, roles.app];
  for (const name of named) {
    if (managed.has(name)) continue;
    if (!(await roleExists(runner, name))) {
      throw new OkmError("not_found", `Role ${name} is named in roles and does not exist.`, {
        kind: "not_found",
        fix: { summary: "Create the role, or list it in roles.managed so the plan creates it." },
      });
    }
  }
  if (managed.size > 0) await assertCreateRole(runner, await currentUser(runner));
  for (const object of objects) {
    if (object.kind !== "grant" || object.identity.role !== roles.app) continue;
    await assertGrant(runner, object);
  }
}

/**
 * Refuses to apply role changes when the acting role lacks `CREATEROLE`.
 *
 * @param runner - Database connection
 * @param role - The role that will run `CREATE ROLE` or `ALTER ROLE`
 */
export async function assertCreateRole(runner: Runner, role: string): Promise<void> {
  const result = await runner.execute("select rolcreaterole from pg_roles where rolname = $1", [
    role,
  ]);
  if (!truthy(result.rows[0]?.[0])) {
    throw new OkmError("forbidden", `Role ${role} lacks CREATEROLE. Nothing was changed.`, {
      kind: "forbidden",
      fix: { summary: "Grant CREATEROLE to the role that applies migrations." },
    });
  }
}

/**
 * Reads `current_user`.
 *
 * @param runner - Database connection
 * @returns The role this session is acting as
 */
export async function currentUser(runner: Runner): Promise<string> {
  const result = await runner.execute("select current_user");
  const name = result.rows[0]?.[0];
  return typeof name === "string" ? name : "";
}

/**
 * Reports whether `pg_roles` has the name.
 *
 * @param runner - Database connection
 * @param name - Role name
 * @returns `true` when the role exists
 */
export async function roleExists(runner: Runner, name: string): Promise<boolean> {
  const result = await runner.execute("select 1 from pg_roles where rolname = $1", [name]);
  return result.rows.length > 0;
}

async function assertGrant(runner: Runner, object: GrantObject): Promise<void> {
  const target = object.identity.object;
  const schema = target.namespace.form === "static" ? target.namespace.name : "public";
  const privilege = object.identity.privilege;
  if (target.kind === "function") {
    const open = target.name.lastIndexOf("(");
    const fn = open < 0 ? target.name : target.name.slice(0, open);
    const args = open < 0 ? "" : target.name.slice(open + 1, -1);
    if (!(await functionExists(runner, schema, fn, args))) return;
    const allowed = await runner.execute(
      "select has_function_privilege($1, format('%I.%I(%s)', $2::text, $3::text, $4::text), $5)",
      [object.identity.role, schema, fn, args, privilege],
    );
    if (!truthy(allowed.rows[0]?.[0])) missing(object, `${schema}.${fn}`);
    return;
  }
  if (target.kind === "namespace") return;
  const relkinds =
    target.kind === "sequence"
      ? "'S'"
      : target.kind === "view"
        ? "'v'"
        : target.kind === "materializedView"
          ? "'m'"
          : "'r', 'p'";
  if (!(await relationExists(runner, schema, target.name, relkinds))) return;
  const probe =
    target.kind === "sequence"
      ? "select has_sequence_privilege($1, format('%I.%I', $2::text, $3::text), $4)"
      : "select has_table_privilege($1, format('%I.%I', $2::text, $3::text), $4)";
  const allowed = await runner.execute(probe, [
    object.identity.role,
    schema,
    target.name,
    privilege,
  ]);
  if (!truthy(allowed.rows[0]?.[0])) missing(object, `${schema}.${target.name}`);
}

function missing(object: GrantObject, name: string): never {
  throw new OkmError(
    "OKM1825",
    `Role ${object.identity.role} lacks ${object.identity.privilege} on ${name}.`,
    {
      kind: "forbidden",
      fix: {
        summary:
          "Grant the privilege, or change the role. okm doctor reports the object and the privilege.",
      },
    },
  );
}

async function relationExists(
  runner: Runner,
  schema: string,
  name: string,
  relkinds: string,
): Promise<boolean> {
  const result = await runner.execute(
    `select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relname = $2 and c.relkind in (${relkinds})`,
    [schema, name],
  );
  return result.rows.length > 0;
}

async function functionExists(
  runner: Runner,
  schema: string,
  name: string,
  args: string,
): Promise<boolean> {
  const result = await runner.execute(
    `select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = $1 and p.proname = $2
       and ${FUNCTION_ARG_TYPES} = $3`,
    [schema, name, args],
  );
  return result.rows.length > 0;
}

function truthy(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}
