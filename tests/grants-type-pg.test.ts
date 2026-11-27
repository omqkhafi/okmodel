/**
 * `grants.type` on a real server: enum, domain, composite, and schema.
 *
 * `proof:grants.range` is the range type. `NEON_*` and `SUPABASE_*` are unset.
 */

import { expect } from "bun:test";

import { catalog } from "../src/contracts/catalog/build.js";
import type { CatalogQuery } from "../src/dialects/pg/introspect.js";
import { introspectSchema } from "../src/dialects/pg/introspect.js";
import { quoteIdent } from "../src/dialects/pg/ddl.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { rememberGrants } from "../src/dialects/pg/role/grant-slot.js";
import { attachRoles } from "../src/dialects/pg/role/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();

for (const name of [
  "NEON_R1_URL",
  "NEON_R2_URL",
  "NEON_POOL_URL",
  "NEON_URL",
  "NEON_R2_POOL_URL",
  "NEON_R1_POOL_URL",
  "SUPABASE_URL",
  "SUPABASE_TRANSACTION_POOL_URL",
  "SUPABASE_SESSION_POOL_URL",
] as const) {
  delete process.env[name];
}

postgresTest(gate, "proof:grants.type", async () => {
  const mig = roleName("mig");
  const app = roleName("app");
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    await sql.unsafe(`create role ${quoteIdent(mig)} nologin`);
    await sql.unsafe(`create role ${quoteIdent(app)} nologin`);
    const people = table("people", {
      id: t.integer().primaryKey(),
      status: t.enum("person_status", ["open", "closed"], { grants: { app: "read" } }),
      code: t.domain("person_code", t.text(), "length(VALUE) > 0", { grants: { app: "read" } }),
      home: t.composite("person_address", { street: t.text() }, { grants: { app: "read" } }),
    });
    const source = schema({ tables: [people] }).catalog;
    rememberGrants("namespace", "public", "public", { app: ["usage", "create"] });
    const declared = attachRoles(source, {
      migration: { name: mig },
      app: { name: app },
    });
    await applyTarget({
      url: database.url,
      target: "default",
      protected: false,
      migrations: [
        {
          id: "0001_types",
          catalogHash: "types",
          steps: planMigration({ before: catalog([]), after: declared, name: "types" }).steps,
        },
      ],
    });
    const granted = await acls(sql, app);
    expect(granted.types.sort()).toEqual(["person_address", "person_code", "person_status"]);
    expect(granted.schema.sort()).toEqual(["CREATE", "USAGE"]);
    const live = await introspectSchema(queryOf(sql), "public", "public", {
      managedRoles: [mig, app],
    });
    const again = planMigration({ before: live, after: declared, name: "again" }).steps.filter(
      (step) => /grant|revoke/i.test(step.sql),
    );
    expect(again).toEqual([]);
    await sql.unsafe(
      `revoke usage on type public.person_status, public.person_code, public.person_address from ${quoteIdent(app)}`,
    );
    await sql.unsafe(`revoke usage, create on schema public from ${quoteIdent(app)}`);
    const revoked = await acls(sql, app);
    expect(revoked.types).toEqual([]);
    expect(revoked.schema).toEqual([]);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
    await dropRole(app);
    await dropRole(mig);
  }
});

postgresTest(gate, "proof:grants.range", async () => {
  const mig = roleName("mig");
  const app = roleName("app");
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    await sql.unsafe(`create role ${quoteIdent(mig)} nologin`);
    await sql.unsafe(`create role ${quoteIdent(app)} nologin`);
    const source = schema({
      tables: [
        table("marks", {
          id: t.integer().primaryKey(),
          during: t.range("span", { subtype: t.integer(), grants: { app: "read" } }),
        }),
      ],
    }).catalog;
    const declared = attachRoles(source, {
      migration: { name: mig },
      app: { name: app },
    });
    await applyTarget({
      url: database.url,
      target: "default",
      protected: false,
      migrations: [
        {
          id: "0001_range",
          catalogHash: "range",
          steps: planMigration({ before: catalog([]), after: declared, name: "range" }).steps,
        },
      ],
    });
    const granted = await sql<{ name: string }[]>`
      select t.typname as name
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
      cross join lateral aclexplode(t.typacl) as a
      join pg_roles r on r.oid = a.grantee
      where n.nspname = 'public'
        and r.rolname = ${app}
        and a.privilege_type = 'USAGE'
        and t.typname = 'span'
    `;
    expect(granted.map((row) => row.name)).toEqual(["span"]);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
    await dropRole(app);
    await dropRole(mig);
  }
});

function roleName(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

async function dropRole(name: string): Promise<void> {
  const sql = openPostgres();
  try {
    await sql.unsafe(`drop role if exists ${quoteIdent(name)}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function queryOf(sql: ReturnType<typeof openPostgres>): CatalogQuery {
  return {
    async query(text: string, params?: readonly unknown[]) {
      const rows = await sql.unsafe(text, params as never[]);
      return rows as readonly Record<string, unknown>[];
    },
  };
}

async function acls(
  sql: ReturnType<typeof openPostgres>,
  role: string,
): Promise<{ types: string[]; schema: string[] }> {
  const types = await sql<{ name: string }[]>`
    select t.typname as name
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    cross join lateral aclexplode(t.typacl) as a
    join pg_roles r on r.oid = a.grantee
    where n.nspname = 'public'
      and r.rolname = ${role}
      and a.privilege_type = 'USAGE'
      and t.typname in ('person_status', 'person_code', 'person_address')
  `;
  const schemaGrants = await sql<{ privilege: string }[]>`
    select a.privilege_type as privilege
    from pg_namespace n
    cross join lateral aclexplode(n.nspacl) as a
    join pg_roles r on r.oid = a.grantee
    where n.nspname = 'public' and r.rolname = ${role}
  `;
  return {
    types: types.map((row) => row.name),
    schema: schemaGrants.map((row) => row.privilege),
  };
}
