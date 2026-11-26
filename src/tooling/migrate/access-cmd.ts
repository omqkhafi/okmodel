/**
 * `okm access`. Read only. JSON has no secrets.
 *
 * Policies arrive with the RLS step. This command lists grants, the grantor,
 * memberships, and unmanaged roles.
 */

import { open } from "../../adapters/pg/postgresjs.js";
import { normalizeRoles } from "../../dialects/pg/role/config.js";
import { OkmError } from "../../contracts/error.js";
import type { MigrateConfig } from "./config.js";

/** One grant row. */
export type AccessGrant = {
  readonly role: string;
  readonly privilege: string;
  readonly object: string;
  readonly grantor: string;
};

/**
 * Reads grants for one table or one role.
 *
 * @param config - Project config
 * @param url - Migration URL. Not printed
 * @param which - Table name or role key
 * @returns Rows and unmanaged role names
 */
export async function accessReport(
  config: MigrateConfig,
  url: string,
  which: string,
): Promise<{
  readonly grants: readonly AccessGrant[];
  readonly memberships: readonly { readonly role: string; readonly memberOf: string }[];
  readonly unmanaged: readonly string[];
  readonly policies: readonly string[];
}> {
  if (config.roles === undefined) {
    throw new OkmError(
      "OKM1910",
      'roles is not configured.\n  roles: { migration: { name: "okm_migrate", env: "MIGRATE_DATABASE_URL" }, app: { name: "okm_app", env: "APP_DATABASE_URL" } }\nThen run okm roles apply --admin-env <NAME>.',
      { fix: { summary: "Add roles to okmodel.config.ts." } },
    );
  }
  const roles = normalizeRoles(config.roles);
  const named = new Set(roles.map((entry) => entry.name));
  const role = roles.find((entry) => entry.key === which || entry.name === which);
  const pool = open({ url, max: 1 });
  try {
    const tableName = role === undefined ? which : "";
    const roleName = role?.name ?? "";
    const grants = await pool.execute(
      `select g.rolname as role, a.privilege_type, c.relname, o.rolname as grantor
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(c.relacl) a
       join pg_roles g on g.oid = a.grantee
       join pg_roles o on o.oid = a.grantor
       where n.nspname = 'public'
         and (($1 <> '' and c.relname = $1) or ($2 <> '' and g.rolname = $2))
       order by c.relname, g.rolname, a.privilege_type`,
      [tableName, roleName],
    );
    const members =
      roleName.length > 0
        ? [roleName]
        : [
            ...new Set(
              grants.rows.map((row) => String(row[0] ?? "")).filter((name) => name.length > 0),
            ),
          ];
    const memberships =
      members.length === 0
        ? { rows: [] as readonly (readonly (string | null)[])[] }
        : await pool.execute(
            `select u.rolname, r.rolname from pg_auth_members m
             join pg_roles r on r.oid = m.roleid
             join pg_roles u on u.oid = m.member
             where u.rolname = any(string_to_array($1, ','))
             order by u.rolname, r.rolname`,
            [members.join(",")],
          );
    const extra = await pool.execute(
      "select rolname from pg_roles where rolname !~ '^pg_' order by rolname",
    );
    return {
      grants: grants.rows.map((row) => ({
        role: String(row[0] ?? ""),
        privilege: String(row[1] ?? ""),
        object: String(row[2] ?? ""),
        grantor: String(row[3] ?? ""),
      })),
      memberships: memberships.rows.map((row) => ({
        role: String(row[0] ?? ""),
        memberOf: String(row[1] ?? ""),
      })),
      unmanaged: extra.rows
        .map((row) => String(row[0] ?? ""))
        .filter((name) => name.length > 0 && !named.has(name)),
      policies: [],
    };
  } finally {
    await pool.close();
  }
}
