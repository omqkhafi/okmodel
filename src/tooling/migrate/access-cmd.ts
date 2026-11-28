/**
 * `okm access`. Read only. JSON has no secrets.
 *
 * Policies arrive with the RLS step. This command lists grants, the grantor,
 * memberships, and unmanaged roles.
 */

import { open } from "../../adapters/pg/postgresjs.js";
import { normalizeRoles } from "../../dialects/pg/role/config.js";
import { OkmError } from "../../contracts/error.js";
import { formatLiveEventTriggers, readEventTriggers } from "./event-check.js";
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
  readonly policies: readonly {
    readonly command: string;
    readonly role: string;
    readonly or: readonly string[];
    readonly and: readonly string[];
    readonly warnings: readonly string[];
  }[];
  /** Live event triggers. Undeclared rows say `unmanaged`. */
  readonly eventTriggers: string;
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
    const routines = await pool.execute(
      `select g.rolname as role, a.privilege_type, p.proname, o.rolname as grantor, p.prokind
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       cross join lateral aclexplode(p.proacl) a
       join pg_roles g on g.oid = a.grantee
       join pg_roles o on o.oid = a.grantor
       where n.nspname = 'public'
         and p.prokind = 'p'
         and p.proacl is not null
         and (($1 <> '' and p.proname = $1) or ($2 <> '' and g.rolname = $2))
       order by p.proname, g.rolname, a.privilege_type`,
      [tableName, roleName],
    );
    const grants = await pool.execute(
      `select g.rolname as role, a.privilege_type, c.relname, o.rolname as grantor, c.relkind
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(c.relacl) a
       join pg_roles g on g.oid = a.grantee
       join pg_roles o on o.oid = a.grantor
       where n.nspname = 'public'
         and c.relkind in ('r', 'p', 'v', 'm', 'S')
         and (($1 <> '' and c.relname = $1) or ($2 <> '' and g.rolname = $2))
       order by c.relname, g.rolname, a.privilege_type`,
      [tableName, roleName],
    );
    const typeGrants = await pool.execute(
      `select g.rolname as role, a.privilege_type, t.typname, o.rolname as grantor
       from pg_type t
       join pg_namespace n on n.oid = t.typnamespace
       cross join lateral aclexplode(t.typacl) a
       join pg_roles g on g.oid = a.grantee
       join pg_roles o on o.oid = a.grantor
       where n.nspname = 'public'
         and t.typtype in ('e', 'd', 'c', 'r')
         and (($1 <> '' and t.typname = $1) or ($2 <> '' and g.rolname = $2))
       order by t.typname, g.rolname, a.privilege_type`,
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
      grants: [
        ...grants.rows.map((row) => {
          const name = String(row[2] ?? "");
          return {
            role: String(row[0] ?? ""),
            privilege: String(row[1] ?? ""),
            object: String(row[4] ?? "") === "S" ? `sequence ${name}` : name,
            grantor: String(row[3] ?? ""),
          };
        }),
        ...typeGrants.rows.map((row) => ({
          role: String(row[0] ?? ""),
          privilege: String(row[1] ?? ""),
          object: `type ${String(row[2] ?? "")}`,
          grantor: String(row[3] ?? ""),
        })),
        ...routines.rows.map((row) => ({
          role: String(row[0] ?? ""),
          privilege: String(row[1] ?? ""),
          object: `procedure ${String(row[2] ?? "")}`,
          grantor: String(row[3] ?? ""),
        })),
      ],
      memberships: memberships.rows.map((row) => ({
        role: String(row[0] ?? ""),
        memberOf: String(row[1] ?? ""),
      })),
      unmanaged: extra.rows
        .map((row) => String(row[0] ?? ""))
        .filter((name) => name.length > 0 && !named.has(name)),
      policies: await policyPart(pool, tableName, roleName),
      eventTriggers: formatLiveEventTriggers(await readEventTriggers(url), new Set()).trim(),
    };
  } finally {
    await pool.close();
  }
}

const COMMANDS: Readonly<Record<string, string>> = {
  "*": "all",
  r: "select",
  a: "insert",
  w: "update",
  d: "delete",
};

async function policyPart(
  pool: {
    execute(
      sql: string,
      params?: readonly string[],
    ): Promise<{ rows: readonly (readonly (string | null)[])[] }>;
  },
  tableName: string,
  roleName: string,
): Promise<
  readonly {
    readonly command: string;
    readonly role: string;
    readonly or: readonly string[];
    readonly and: readonly string[];
    readonly warnings: readonly string[];
  }[]
> {
  const rows = await pool.execute(
    `select c.relname, p.polname, p.polcmd, p.polpermissive::text,
            coalesce((
              select string_agg(r.rolname, ',' order by r.rolname)
              from pg_roles r
              where r.oid = any(p.polroles)
            ), 'public')
     from pg_policy p
     join pg_class c on c.oid = p.polrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and (($1 <> '' and c.relname = $1) or ($2 <> '' and (
         p.polroles = '{}'::oid[]
         or exists (select 1 from pg_roles r where r.oid = any(p.polroles) and r.rolname = $2)
       )))
     order by c.relname, p.polname`,
    [tableName, roleName],
  );
  const groups = new Map<string, { or: string[]; and: string[] }>();
  const selectRoles = new Set<string>();
  const restrictiveSelect = new Set<string>();
  for (const row of rows.rows) {
    const command = COMMANDS[String(row[2] ?? "")] ?? String(row[2] ?? "");
    const roles = String(row[4] ?? "public").split(",");
    const permissive = String(row[3] ?? "") === "true";
    const policy = String(row[1] ?? "");
    for (const role of roles) {
      const key = `${command}\0${role}`;
      const group = groups.get(key) ?? { or: [], and: [] };
      if (permissive) group.or.push(policy);
      else group.and.push(policy);
      groups.set(key, group);
      if (command === "select" || command === "all") selectRoles.add(role);
      if (!permissive && command === "select") restrictiveSelect.add(role);
    }
  }
  return [...groups.entries()].map(([key, group]) => {
    const [command, role] = key.split("\0");
    const warnings: string[] = [];
    if (command === "update" && role !== undefined && !selectRoles.has(role)) {
      warnings.push("UPDATE with no SELECT policy for this role matches zero rows");
    }
    if (
      role !== undefined &&
      restrictiveSelect.has(role) &&
      (command === "insert" || command === "delete")
    ) {
      warnings.push("a restrictive SELECT policy changes RETURNING for this role");
    }
    return {
      command: command ?? "",
      role: role ?? "",
      or: group.or,
      and: group.and,
      warnings,
    };
  });
}
