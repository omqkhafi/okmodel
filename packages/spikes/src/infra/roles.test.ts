/**
 * Roles and grants on a real Postgres.
 *
 * Roles are cluster-wide. The catalog is per database. These tests apply the
 * shared plan and record what that mismatch does.
 */

import { expect } from "bun:test";

import { isolatedSchemaName, openPostgres, primaryUrl } from "@okmodel/harness";
import type { Sql } from "postgres";

import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "../catalog/gate.js";
import { staticNamespace, type CatalogObject } from "../catalog/object.js";
import { quoteIdent } from "../catalog/sql.js";
import { diffCatalog } from "../migrations/diff.js";
import { planMigration, planSql } from "../migrations/plan.js";
import { type NamespaceBinding } from "../catalog/render.js";
import { privilegeRoundTrip, privilegeScale, role } from "./build.js";
import { introspectPrivileges, privilegeMismatches } from "./introspect.js";
import {
  dropRole,
  errorDetail,
  errorMessage,
  sqlState,
  withThrowawayDatabase,
  withTwoDatabases,
} from "./session.js";
import { postgresRunner } from "../catalog/runners.js";

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

postgresTest(decision, "roles, grants, and default privileges round-trip", async () => {
  const migrationRole = roleName("mig");
  const appRole = roleName("app");
  await withThrowawayDatabase(async (sql) => {
    const schema = isolatedSchemaName();
    const namespace = staticNamespace(schema);
    const bindings: readonly NamespaceBinding[] = [{ logical: namespace, concrete: schema }];
    try {
      await sql.unsafe(`create schema ${quoteIdent(schema)}`);
      const catalog = privilegeRoundTrip(namespace, migrationRole, appRole);
      await applyPlan(sql, [], catalog, bindings);
      const runner = postgresRunner(sql);
      const actual = await introspectPrivileges(
        runner,
        namespace,
        schema,
        [migrationRole, appRole],
        () => "managed",
      );
      expect(privilegeMismatches(catalog, actual)).toEqual([]);
      const locks = await grantLockModes(sql, schema, appRole);
      console.log(JSON.stringify({ event: "infra-grant-locks", modes: locks }));
    } finally {
      await dropRole(sql, appRole);
      await dropRole(sql, migrationRole);
    }
  });
});

postgresTest(
  decision,
  "a role that already exists is external, and a managed create fails",
  async () => {
    const name = roleName("exists");
    await withThrowawayDatabase(async (sql) => {
      const schema = isolatedSchemaName();
      const namespace = staticNamespace(schema);
      const bindings: readonly NamespaceBinding[] = [{ logical: namespace, concrete: schema }];
      try {
        await sql.unsafe(`create schema ${quoteIdent(schema)}`);
        await sql.unsafe(`create role ${quoteIdent(name)} nologin inherit`);
        const managed = [role(name, "managed", false)];
        const create = planSql(planMigration([], managed, bindings));
        expect(create).toContain(`create role ${quoteIdent(name)} nologin inherit`);
        const duplicate = await applyExpectingError(sql, create);
        expect(duplicate.code).toBe("42710");
        const external = privilegeRoundTrip(
          namespace,
          name,
          roleName("app"),
          "external",
          "managed",
        );
        const app = external.find(
          (object) => object.kind === "role" && object.identity.name !== name,
        );
        if (app === undefined || app.kind !== "role") throw new Error("Missing application role.");
        try {
          const planned = planSql(
            planMigration([role(name, "external", false)], external, bindings),
          );
          expect(
            planned.some(
              (statement) => statement.startsWith("create role") && statement.includes(name),
            ),
          ).toBe(false);
          for (const statement of planned) await sql.unsafe(statement);
          const runner = postgresRunner(sql);
          const actual = await introspectPrivileges(
            runner,
            namespace,
            schema,
            [name, app.identity.name],
            (roleNameToOwn) => (roleNameToOwn === name ? "external" : "managed"),
          );
          expect(privilegeMismatches(external, actual)).toEqual([]);
        } finally {
          await dropRole(sql, app.identity.name);
        }
      } finally {
        await dropRole(sql, name);
      }
    });
  },
);

postgresTest(decision, "creating a role needs CREATEROLE, not merely a superuser bit", async () => {
  const creator = roleName("creator");
  const plain = roleName("plain");
  const child = roleName("child");
  const admin = openPostgres();
  try {
    const superuser = await admin<{ rolsuper: boolean; rolcreaterole: boolean }[]>`
      select rolsuper, rolcreaterole from pg_roles where rolname = current_user
    `;
    console.log(
      JSON.stringify({
        event: "infra-role-session",
        user: "okm",
        superuser: superuser[0]?.rolsuper,
        createrole: superuser[0]?.rolcreaterole,
      }),
    );
    await admin.unsafe(
      `create role ${quoteIdent(creator)} login password 'okm_p08_pw' nosuperuser createrole`,
    );
    await admin.unsafe(
      `create role ${quoteIdent(plain)} login password 'okm_p08_pw' nosuperuser nocreaterole nocreatedb`,
    );
    const created = await asRole(creator, async (sql) => {
      await sql.unsafe(`create role ${quoteIdent(child)} nologin`);
      const rows = await sql<{ rolsuper: boolean; rolcreaterole: boolean }[]>`
        select rolsuper, rolcreaterole from pg_roles where rolname = current_user
      `;
      return rows[0];
    });
    expect(created?.rolsuper).toBe(false);
    expect(created?.rolcreaterole).toBe(true);
    const denied = await asRole(plain, async (sql) => {
      try {
        await sql.unsafe(`create role ${quoteIdent(roleName("denied"))} nologin`);
        return { code: "", message: "" };
      } catch (error) {
        return { code: sqlState(error), message: errorMessage(error) };
      }
    });
    expect(denied.code).toBe("42501");
    console.log(
      JSON.stringify({ event: "infra-role-denied", code: denied.code, message: denied.message }),
    );
  } finally {
    await dropRole(admin, child);
    await dropRole(admin, creator);
    await dropRole(admin, plain);
    await admin.end({ timeout: 5 });
  }
});

postgresTest(
  decision,
  "a role is visible in every database, and DROP ROLE is cluster-wide",
  async () => {
    const name = roleName("cluster");
    await withTwoDatabases(async (left, right) => {
      try {
        await left.unsafe(`create role ${quoteIdent(name)} nologin`);
        const seen = await right<{ count: string }[]>`
        select count(*)::text as count from pg_roles where rolname = ${name}
      `;
        expect(seen[0]?.count).toBe("1");
        await right.unsafe(`create schema app`);
        await right.unsafe(`create table app.tasks (id int8)`);
        await right.unsafe(`grant select on app.tasks to ${quoteIdent(name)}`);
        const dropped = await applyExpectingError(left, [`drop role ${quoteIdent(name)}`]);
        console.log(
          JSON.stringify({
            event: "infra-role-drop-other-database",
            code: dropped.code,
            message: dropped.message,
            detail: dropped.detail,
          }),
        );
        expect(dropped.code).not.toBe("");
        const still = await right<{ count: string }[]>`
        select count(*)::text as count from pg_roles where rolname = ${name}
      `;
        expect(still[0]?.count).toBe("1");
      } finally {
        await right.unsafe(`drop owned by ${quoteIdent(name)}`);
        await dropRole(left, name);
      }
    });
  },
);

postgresTest(
  decision,
  "introspection and diff of 50 roles and 1000 grants",
  async () => {
    const prefix = `p${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`;
    await withThrowawayDatabase(async (sql) => {
      const schema = isolatedSchemaName();
      const namespace = staticNamespace(schema);
      const bindings: readonly NamespaceBinding[] = [{ logical: namespace, concrete: schema }];
      const catalog = privilegeScale(namespace, prefix);
      const roles = catalog
        .filter((object) => object.kind === "role")
        .map((object) => object.identity.name);
      try {
        await sql.unsafe(`create schema ${quoteIdent(schema)}`);
        const applyStarted = performance.now();
        await applyPlan(sql, [], catalog, bindings);
        const applyMs = performance.now() - applyStarted;
        const runner = postgresRunner(sql);
        const introStarted = performance.now();
        const actual = await introspectPrivileges(
          runner,
          namespace,
          schema,
          roles,
          () => "managed",
        );
        const introspectMs = performance.now() - introStarted;
        const privileges = catalog.filter(
          (object) => object.kind === "role" || object.kind === "grant",
        );
        const diffStarted = performance.now();
        const diff = diffCatalog(privileges, actual);
        const diffMs = performance.now() - diffStarted;
        const mismatches = privilegeMismatches(catalog, actual);
        expect(mismatches).toEqual([]);
        expect(diff.create).toHaveLength(0);
        expect(diff.drop).toHaveLength(0);
        console.log(
          JSON.stringify({
            event: "infra-privilege-scale",
            roles: roles.length,
            grants: catalog.filter((object) => object.kind === "grant").length,
            applyMs,
            introspectMs,
            diffMs,
          }),
        );
      } finally {
        for (const name of roles) await dropRole(sql, name);
      }
    });
  },
  120_000,
);

postgresTest(decision, "default privileges apply only to objects that role creates", async () => {
  const migrationRole = roleName("mig");
  const appRole = roleName("app");
  await withThrowawayDatabase(async (sql) => {
    try {
      await sql.unsafe(`create role ${quoteIdent(migrationRole)} nologin inherit`);
      await sql.unsafe(`create role ${quoteIdent(appRole)} nologin inherit`);
      await sql.unsafe(`create schema app`);
      await sql.unsafe(`grant usage, create on schema app to ${quoteIdent(migrationRole)}`);
      await sql.unsafe(
        `alter default privileges for role ${quoteIdent(migrationRole)} in schema app grant select on tables to ${quoteIdent(appRole)}`,
      );
      await sql.unsafe(`set role ${quoteIdent(migrationRole)}`);
      await sql.unsafe(`create table app.by_migration (id int8)`);
      await sql.unsafe(`reset role`);
      await sql.unsafe(`create table app.by_session (id int8)`);
      const migrationGrant = await hasSelect(sql, "app", "by_migration", appRole);
      const sessionGrant = await hasSelect(sql, "app", "by_session", appRole);
      console.log(
        JSON.stringify({
          event: "infra-default-privileges",
          migrationRoleCreates: migrationGrant,
          sessionRoleCreates: sessionGrant,
        }),
      );
      expect(migrationGrant).toBe(true);
      expect(sessionGrant).toBe(false);
    } finally {
      await dropRole(sql, appRole);
      await dropRole(sql, migrationRole);
    }
  });
});

function roleName(label: string): string {
  return `${label}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

async function applyPlan(
  sql: Sql,
  before: readonly CatalogObject[],
  after: readonly CatalogObject[],
  bindings: readonly NamespaceBinding[],
): Promise<void> {
  for (const statement of planSql(planMigration(before, after, bindings))) {
    await sql.unsafe(statement);
  }
}

async function applyExpectingError(
  sql: Sql,
  statements: readonly string[],
): Promise<{ readonly code: string; readonly message: string; readonly detail: string }> {
  try {
    for (const statement of statements) await sql.unsafe(statement);
    return { code: "", message: "", detail: "" };
  } catch (error) {
    return { code: sqlState(error), message: errorMessage(error), detail: errorDetail(error) };
  }
}

async function asRole<T>(name: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const url = new URL(primaryUrl());
  url.username = name;
  url.password = "okm_p08_pw";
  const sql = openPostgres(url.toString());
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function grantLockModes(
  sql: Sql,
  schema: string,
  grantee: string,
): Promise<readonly string[]> {
  await sql.unsafe("begin");
  try {
    await sql.unsafe(`grant insert on table ${quoteIdent(schema)}.tasks to ${quoteIdent(grantee)}`);
    const rows = await sql.unsafe<{ relname: string; mode: string }[]>(
      `select c.relname, l.mode
       from pg_locks l
       join pg_class c on c.oid = l.relation
       where l.pid = pg_backend_pid() and l.locktype = 'relation'`,
    );
    return rows.map((row) => `${row.relname}:${row.mode}`);
  } finally {
    await sql.unsafe("rollback");
  }
}

async function hasSelect(
  sql: Sql,
  schema: string,
  table: string,
  grantee: string,
): Promise<boolean> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    join pg_roles r on r.oid = a.grantee
    where n.nspname = ${schema} and c.relname = ${table}
      and r.rolname = ${grantee} and a.privilege_type = 'SELECT'
  `;
  return rows[0]?.count === "1";
}
