/**
 * Keyed policies, session lists, and role switching on real Postgres.
 *
 * `NEON_*` and `SUPABASE_*` are unset for this file. Those hosts are not
 * reachable from this environment.
 */

import { expect } from "bun:test";
import postgres, { type Sql } from "postgres";

import { settingList } from "../src/dialects/pg/expr/index.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase } from "../packages/harness/src/postgres.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { assertBackfillVisible, probeTarget } from "../src/tooling/migrate/data-probe.js";
import { sessionSettings } from "../src/runtime/session/index.js";
import "../src/dialects/pg/policy-compile.js";

const gate = await loadPostgresGate();

for (const name of ["NEON_DATABASE_URL", "SUPABASE_DATABASE_URL"] as const) {
  delete process.env[name];
}

const LIST_CASES: readonly (readonly (string | null)[])[] = [
  ["a,b"],
  ['say "hi"'],
  ["{brace}"],
  ["back\\slash"],
  ["has space"],
  [""],
  ["مرحبا"],
  ["café"],
  [null],
  ["NULL"],
  ["a,b", null, "NULL"],
  [],
];

function queryOf(sql: Sql): CatalogQuery {
  return {
    async query(text, params) {
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return rows.map((row) => {
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) copy[key] = value;
        return copy;
      });
    },
  };
}

async function expectSqlState(run: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) throw new Error(`expected SQLSTATE ${code}`);
  expect((caught as { code?: string }).code).toBe(code);
}

function roleName(): string {
  return `p${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

async function openSql(url: string): Promise<Sql> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql.unsafe("set statement_timeout = '8s'");
  return sql;
}

async function ensureRole(sql: Sql, name: string, extra = "nologin"): Promise<void> {
  await sql.unsafe(`
    do $$ begin
      create role ${name} ${extra};
    exception
      when duplicate_object then null;
    end $$;
  `);
  await sql.unsafe(`alter role ${name} ${extra}`);
}

async function apply(sql: Sql, statements: readonly string[]): Promise<void> {
  await sql.unsafe("begin");
  try {
    for (const statement of statements) {
      if (statement.trim().length === 0) continue;
      await sql.unsafe(statement);
    }
    await sql.unsafe("commit");
  } catch (error) {
    await sql.unsafe("rollback");
    throw error;
  }
}

postgresTest(gate, "proof:policies.permissive", async () => {
  const database = await createIsolatedDatabase();
  const sql = await openSql(database.url);
  const role = roleName();
  try {
    await ensureRole(sql, role);
    await sql.unsafe(`grant ${role} to current_user`);
    const built = schema({
      tables: [
        table(
          "notes",
          { id: t.integer().primaryKey(), body: t.text() },
          {
            policies: () => ({ read: { for: "select", to: role, using: true } }),
          },
        ),
      ],
    });
    const plan = planMigration({
      before: schema({ tables: [] }).catalog,
      after: built.catalog,
      name: "add",
    });
    await apply(
      sql,
      plan.steps.map((step) => step.sql),
    );
    const live = await introspectSchema(queryOf(sql), "public", "public");
    const again = planMigration({ before: live, after: built.catalog, name: "round" });
    expect(
      again.steps.filter((step) => step.kind.includes("policy") || step.kind.includes("rls")),
    ).toHaveLength(0);
    await sql.unsafe("insert into notes (id, body) values (1, 'a')");
    await sql.unsafe(`grant select on notes to ${role}`);
    await sql.unsafe(`set role ${role}`);
    const rows = await sql.unsafe("select id from notes");
    expect(rows).toHaveLength(1);
    await sql.unsafe("reset role");
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

postgresTest(gate, "proof:policies.restrictive", async () => {
  const database = await createIsolatedDatabase();
  const sql = await openSql(database.url);
  const role = roleName();
  try {
    await ensureRole(sql, role);
    await sql.unsafe(`grant ${role} to current_user`);
    await sql.unsafe("create table items (id integer primary key)");
    await sql.unsafe("alter table items enable row level security");
    await sql.unsafe("alter table items force row level security");
    await sql.unsafe(`grant select, insert, delete on items to ${role}`);
    await sql.unsafe(
      `create policy allow on items as permissive for all to ${role} using (true) with check (true)`,
    );
    await sql.unsafe(
      `create policy see_one on items as restrictive for select to ${role} using (id = 1)`,
    );
    await sql.unsafe(`set role ${role}`);
    await sql.unsafe("insert into items (id) values (1), (2)");
    await expectSqlState(
      () => sql.unsafe("insert into items (id) values (3) returning id"),
      "42501",
    );
    const removed = await sql.unsafe("delete from items returning id");
    expect(removed).toHaveLength(1);
    await sql.unsafe("reset role");
    await sql.unsafe(`set role ${role}`);
    const plain = await sql.unsafe("delete from items");
    expect(plain.count).toBe(1);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

postgresTest(gate, "proof:session.list", async () => {
  const database = await createIsolatedDatabase();
  const sql = await openSql(database.url);
  try {
    let naiveFailures = 0;
    for (const values of LIST_CASES) {
      const encoded = settingList(values);
      const naive = `{${values.map((value) => (value === null ? "" : value)).join(",")}}`;
      if (naive !== encoded) naiveFailures += 1;
      await sql.unsafe("begin");
      await sql.unsafe("select set_config('app.scopes', $1, true)", [encoded]);
      const rows = await sql.unsafe("select current_setting('app.scopes', true) as raw");
      expect(rows[0]?.raw).toBe(encoded);
      await sql.unsafe("rollback");
    }
    expect(naiveFailures).toBeGreaterThanOrEqual(5);
    await expectSqlState(
      () => sql.unsafe("select ((select coalesce(nullif('nope', ''), '{}')::text[])) as bad"),
      "22P02",
    );
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

postgresTest(gate, "proof:session.role", async () => {
  const database = await createIsolatedDatabase();
  const sql = await openSql(database.url);
  const role = roleName();
  const login = roleName();
  try {
    await ensureRole(sql, role);
    await ensureRole(sql, login, "login password 'stranger-pass'");
    const databaseName = new URL(database.url).pathname.slice(1);
    await sql.unsafe(`grant connect on database "${databaseName}" to ${login}`);
    const url = new URL(database.url);
    url.username = login;
    url.password = "stranger-pass";
    const other = postgres(url.href, { max: 1 });
    try {
      await expectSqlState(
        () => other.unsafe(`select set_config('role', '${role}', true)`),
        "42501",
      );
      await sql.unsafe(`grant ${role} to ${login}`);
      await other.unsafe("begin");
      await other.unsafe(`select set_config('role', '${role}', true)`);
      const who = await other.unsafe("select current_user as who");
      expect(who[0]?.who).toBe(role);
      await other.unsafe("rollback");
      const after = await other.unsafe("select current_user as who");
      expect(after[0]?.who).toBe(login);
    } finally {
      await other.end({ timeout: 5 });
    }
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

postgresTest(gate, "proof:tenancy.keyTypes", async () => {
  const database = await createIsolatedDatabase();
  const sql = await openSql(database.url);
  try {
    const types = [
      ["int", "integer", "7"],
      ["bigint", "bigint", "9007199254740993"],
      ["text", "text", "acme"],
      ["uuid", "uuid", "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d"],
    ] as const;
    for (const [name, dataType, value] of types) {
      await sql.unsafe(
        `create table ${name}_rows (tenant_id ${dataType} not null, id integer not null, primary key (tenant_id, id))`,
      );
      await sql.unsafe(`insert into ${name}_rows (tenant_id, id) values ($1, 1)`, [value]);
      await sql.unsafe("begin");
      await sql.unsafe("select set_config('app.tenant', $1, true)", [value]);
      const plan = await sql.unsafe(
        `explain (format json) select 1 from ${name}_rows where tenant_id = (nullif(current_setting('app.tenant', true), ''))::${dataType}`,
      );
      const text = JSON.stringify(plan);
      expect(text.toLowerCase()).toContain("index");
      const seen = await sql.unsafe(
        `select count(*)::text as n from ${name}_rows where tenant_id = (nullif(current_setting('app.tenant', true), ''))::${dataType}`,
      );
      expect(seen[0]?.n).toBe("1");
      await sql.unsafe("commit");
      const empty = await sql.unsafe(
        `select count(*)::text as n from ${name}_rows where tenant_id = (nullif(current_setting('app.tenant', true), ''))::${dataType}`,
      );
      expect(empty[0]?.n).toBe("0");
    }
    await sql.unsafe("begin");
    await sql.unsafe("select set_config('app.tenant', 'nope', true)");
    await expectSqlState(
      () => sql.unsafe("select (nullif(current_setting('app.tenant', true), ''))::integer"),
      "22P02",
    );
    await sql.unsafe("rollback");
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

postgresTest(gate, "proof:comment.policy", async () => {
  const database = await createIsolatedDatabase();
  const sql = await openSql(database.url);
  try {
    const role = roleName();
    await ensureRole(sql, role);
    const built = schema({
      tables: [
        table(
          "notes",
          { id: t.integer().primaryKey() },
          {
            policies: () => ({ read: { to: role, using: true, comment: "owner reads" } }),
          },
        ),
      ],
    });
    const plan = planMigration({
      before: schema({ tables: [] }).catalog,
      after: built.catalog,
      name: "comment",
    });
    await apply(
      sql,
      plan.steps.map((step) => step.sql),
    );
    const live = await introspectSchema(queryOf(sql), "public", "public");
    const policy = live.objects.find((object) => object.kind === "policy");
    expect(policy?.comment).toBe("owner reads");
    const again = planMigration({ before: live, after: built.catalog, name: "round" });
    expect(again.steps.filter((step) => step.sql.toLowerCase().includes("policy"))).toHaveLength(0);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

postgresTest(gate, "a self-reading policy is 42P17 for a non-bypass role", async () => {
  const database = await createIsolatedDatabase();
  const sql = await openSql(database.url);
  try {
    const role = roleName();
    await ensureRole(sql, role);
    await sql.unsafe(`grant ${role} to current_user`);
    await sql.unsafe("create table notes (id integer primary key)");
    await sql.unsafe("alter table notes enable row level security");
    await sql.unsafe("alter table notes force row level security");
    await sql.unsafe(`grant select on notes to ${role}`);
    await sql.unsafe(
      `create policy loop on notes for select to ${role} using (exists (select 1 from notes n where n.id = notes.id))`,
    );
    await sql.unsafe(`set role ${role}`);
    await expectSqlState(() => sql.unsafe("select * from notes"), "42P17");
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

postgresTest(gate, "a forced table does not probe as zero for a non-bypass role", async () => {
  const database = await createIsolatedDatabase();
  const sql = await openSql(database.url);
  try {
    const role = roleName();
    await ensureRole(sql, role, "login password 'app-pass'");
    const databaseName = new URL(database.url).pathname.slice(1);
    await sql.unsafe(`grant connect on database "${databaseName}" to ${role}`);
    await sql.unsafe(`grant usage on schema public to ${role}`);
    await sql.unsafe("create table notes (id integer primary key, body text)");
    await sql.unsafe("insert into notes (id, body) values (1, 'a'), (2, 'b')");
    await sql.unsafe("alter table notes enable row level security");
    await sql.unsafe("alter table notes force row level security");
    await sql.unsafe(`grant select, update on notes to ${role}`);
    const url = new URL(database.url);
    url.username = role;
    url.password = "app-pass";
    await expectSqlState(
      () => probeTarget(url.href, "public", [{ table: "notes", which: "rows" }]),
      "OKM1926",
    );
    const app = postgres(url.href, { max: 1 });
    try {
      await expectSqlState(
        () =>
          assertBackfillVisible(
            async (text) => {
              const rows = await app.unsafe(text);
              return { rows: rows.map((row) => Object.values(row).map((value) => String(value))) };
            },
            "public",
            "notes",
          ),
        "OKM1926",
      );
    } finally {
      await app.end({ timeout: 5 });
    }
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

postgresTest(gate, "a transaction-local setting is gone for the next client", async () => {
  const database = await createIsolatedDatabase();
  const first = postgres(database.url, { max: 1 });
  const second = postgres(database.url, { max: 1 });
  try {
    await first.unsafe("begin");
    await first.unsafe(
      "select set_config('app.user_id', '01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d', true)",
    );
    await first.unsafe("commit");
    const seen = await second.unsafe("select current_setting('app.user_id', true) as value");
    expect(seen[0]?.value ?? "").toBe("");
    const declared = sessionSettings(
      { userId: { name: "app.user_id", type: "uuid" } },
      { role: "app" },
    );
    expect(declared.role).toBe("app");
    expect(declared.handles.userId).toBeDefined();
  } finally {
    await first.end({ timeout: 5 });
    await second.end({ timeout: 5 });
    await database.close();
  }
});
