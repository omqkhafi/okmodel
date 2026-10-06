/**
 * Safe rewrites applied on Postgres, on tables that already have rows.
 *
 * The same file runs on 15 and 18 through the existing matrix. `okm check`
 * compares the live catalog with the schema; these tests assert that plan is
 * empty, and one push runs `okm check` itself.
 */

import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Sql } from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
import { catalogHash } from "../src/contracts/catalog/document.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { index, schema, table, t } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  createIsolatedDatabase,
  openPostgres,
  withPostgresSchema,
} from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { repoRoot } from "../scripts/root.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import type { StoredMigration } from "../src/tooling/migrate/files.js";
import { planMigration, type PlanStep } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();
const url = primaryUrl();

const users = () => table("users", { id: t.integer().primaryKey(), name: t.text() });
const baseTasks = () =>
  table("tasks", {
    id: t.integer().primaryKey(),
    title: t.text().nullable(),
    ownerId: t.integer(),
  });

postgresTest(
  gate,
  "each safe rewrite applies on a populated table and matches the schema",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const initial = schema({ tables: [users(), baseTasks()] });
      await applyPlan(schemaName, "0001_init", catalog([]), initial.catalog);
      await sql.unsafe(`insert into users (id, name) values (1, 'ada')`);
      await sql.unsafe(`insert into tasks (id, title, "ownerId") values (1, 'a', 1), (2, 'b', 1)`);

      const indexed = table(
        "tasks",
        { id: t.integer().primaryKey(), title: t.text().nullable(), ownerId: t.integer() },
        { indexes: (columns) => [index(columns.title)] },
      );
      const withIndex = schema({ tables: [users(), indexed] });
      const indexPlan = await applyPlan(
        schemaName,
        "0002_index",
        initial.catalog,
        withIndex.catalog,
      );
      expect(indexPlan).toEqual([
        `create index concurrently "tasks_title_idx" on ${q(schemaName)}."tasks" ("title")`,
      ]);
      expect(await indexValid(sql, schemaName, "tasks_title_idx")).toBe(true);

      const checked = table(
        "tasks",
        {
          id: t.integer().primaryKey(),
          title: t.text().nullable().picklist(["a", "b"]),
          ownerId: t.integer(),
        },
        { indexes: (columns) => [index(columns.title)] },
      );
      const withCheck = schema({ tables: [users(), checked] });
      const checkPlan = await applyPlan(
        schemaName,
        "0003_check",
        withIndex.catalog,
        withCheck.catalog,
      );
      expect(checkPlan[0]).toContain("not valid");
      expect(checkPlan[1]).toContain("validate constraint");
      expect(await constraintValidated(sql, schemaName, "tasks_title_check")).toBe(true);

      const linked = table(
        "tasks",
        {
          id: t.integer().primaryKey(),
          title: t.text().nullable().picklist(["a", "b"]),
          ownerId: t.integer().references("users"),
        },
        { indexes: (columns) => [index(columns.title)] },
      );
      const withKey = schema({ tables: [users(), linked] });
      const keyPlan = await applyPlan(schemaName, "0004_fk", withCheck.catalog, withKey.catalog);
      expect(keyPlan[0]).toContain("not valid");
      expect(keyPlan[1]).toBe(
        `alter table ${q(schemaName)}."tasks" validate constraint "tasks_ownerId_fkey"`,
      );
      expect(await constraintValidated(sql, schemaName, "tasks_ownerId_fkey")).toBe(true);

      const required = table(
        "tasks",
        {
          id: t.integer().primaryKey(),
          title: t.text().picklist(["a", "b"]),
          ownerId: t.integer().references("users"),
        },
        { indexes: (columns) => [index(columns.title)] },
      );
      const withRequired = schema({ tables: [users(), required] });
      const nullPlan = await applyPlan(
        schemaName,
        "0005_null",
        withKey.catalog,
        withRequired.catalog,
      );
      expect(nullPlan.map((statement) => statement.replaceAll(`${q(schemaName)}.`, ""))).toEqual([
        'alter table "tasks" add constraint "tasks_title_notnull" check ("title" is not null) not valid',
        'alter table "tasks" validate constraint "tasks_title_notnull"',
        'alter table "tasks" alter column "title" set not null',
        'alter table "tasks" drop constraint "tasks_title_notnull"',
      ]);
      expect(await constraintValidated(sql, schemaName, "tasks_title_notnull")).toBeUndefined();

      const unique = table(
        "tasks",
        {
          id: t.integer().primaryKey(),
          title: t.text().picklist(["a", "b"]).unique(),
          ownerId: t.integer().references("users"),
        },
        { indexes: (columns) => [index(columns.title)] },
      );
      const withUnique = schema({ tables: [users(), unique] });
      const uniquePlan = await applyPlan(
        schemaName,
        "0006_unique",
        withRequired.catalog,
        withUnique.catalog,
      );
      expect(uniquePlan).toEqual([
        `create unique index concurrently "tasks_title_key" on ${q(schemaName)}."tasks" ("title")`,
        `alter table ${q(schemaName)}."tasks" add constraint "tasks_title_key" unique using index "tasks_title_key"`,
      ]);
      expect(await indexValid(sql, schemaName, "tasks_title_key")).toBe(true);
      expect(await constraintValidated(sql, schemaName, "tasks_title_key")).toBe(true);

      const filled = table(
        "tasks",
        {
          id: t.integer().primaryKey(),
          title: t.text().picklist(["a", "b"]).unique(),
          ownerId: t.integer().references("users"),
          token: t.uuid().defaultSql("gen_random_uuid()"),
        },
        { indexes: (columns) => [index(columns.title)] },
      );
      const done = schema({ tables: [users(), filled] });
      const fillPlan = await applyPlan(schemaName, "0007_fill", withUnique.catalog, done.catalog);
      expect(fillPlan[2]).toBe(
        `update ${q(schemaName)}."tasks" set "token" = gen_random_uuid() where "token" is null and ($1::text is null or "id" > $1::integer) and ($2::text is null or "id" <= $2::integer)`,
      );
      const tokens = await sql<{ token: string }[]>`select token::text as token from tasks`;
      expect(tokens).toHaveLength(2);
      expect(tokens[0]?.token).not.toBe(tokens[1]?.token);
      expect(await constraintValidated(sql, schemaName, "tasks_token_notnull")).toBeUndefined();

      const live = await introspectSchema(queryOf(sql), schemaName, "public");
      const drift = planMigration({ before: live, after: done.catalog, name: "check" });
      // Postgres reprints `IN ('a', 'b')` as `= ANY (ARRAY[...])` (D128). That
      // reprint is the only difference. Every other object matches.
      expect(drift.steps.map((step) => step.sql)).toEqual([
        'alter table "public"."tasks" drop constraint "tasks_title_check"',
        `alter table "public"."tasks" add constraint "tasks_title_check" check ((title IN ('a', 'b'))) not valid`,
        'alter table "public"."tasks" validate constraint "tasks_title_check"',
      ]);
      const aligned = alignCheckExpression(done.catalog, live);
      expect(planMigration({ before: live, after: aligned, name: "aligned" }).steps).toEqual([]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a failed concurrent unique index is dropped and rebuilt without repeating finished steps",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const before = schema({ tables: [table("items", { id: t.integer() })] });
      const after = schema({ tables: [table("items", { id: t.integer().unique() })] });
      await applyPlan(schemaName, "0001_items", catalog([]), before.catalog);
      await sql.unsafe(`insert into items (id) values (1), (1)`);
      await sql.unsafe(`create table marker (n integer)`);
      const planned = planMigration({
        before: before.catalog,
        after: after.catalog,
        schema: schemaName,
        name: "unique",
      });
      const steps: PlanStep[] = [
        {
          sql: `insert into ${q(schemaName)}.marker (n) values (1)`,
          class: "expand",
          action: "ddl",
          lock: "ROW EXCLUSIVE",
          transactional: true,
        },
        ...planned.steps,
      ];
      const failed = await catchError(() =>
        applyTo(schemaName, [migration("0002_key", "hash", steps)]),
      );
      expect(messageOf(failed)).toContain("failed at step 1");
      expect(await indexValid(sql, schemaName, "items_id_key")).toBe(false);
      const once = await sql<{ n: number }[]>`select n from marker`;
      expect(once).toHaveLength(1);
      await sql.unsafe(`delete from items where ctid <> (select min(ctid) from items)`);
      await applyTo(schemaName, [migration("0002_key", "hash", steps)]);
      expect(await indexValid(sql, schemaName, "items_id_key")).toBe(true);
      expect(await constraintValidated(sql, schemaName, "items_id_key")).toBe(true);
      expect(await sql<{ n: number }[]>`select n from marker`).toHaveLength(1);
      const history = await sql<{ step_index: number }[]>`
        select step_index from okm_history where migration_id = '0002_key' order by step_index
      `;
      expect(history.map((row) => row.step_index)).toEqual([0, 1, 2]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "validate retries when the lock times out",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table held (id integer)`);
      await sql.unsafe(
        `alter table held add constraint held_id_check check (id is not null) not valid`,
      );
      await sql.unsafe("begin");
      await sql.unsafe(`lock table held in access exclusive mode`);
      const applying = applyTo(
        schemaName,
        [
          migration("0001_validate", "hash", [
            {
              sql: `alter table ${q(schemaName)}.held validate constraint held_id_check`,
              class: "expand",
              kind: "validate-constraint",
              action: "ddl",
              lock: "SHARE UPDATE EXCLUSIVE",
              transactional: true,
            },
          ]),
        ],
        { lockTimeoutMs: 80, retries: 6 },
      );
      await Bun.sleep(250);
      await sql.unsafe("commit");
      await applying;
      expect(await constraintValidated(sql, schemaName, "held_id_check")).toBe(true);
    });
  },
  20_000,
);

postgresTest(
  gate,
  "okm push applies a concurrent index outside the transaction and okm check reports no drift",
  async () => {
    const database = await createIsolatedDatabase();
    const root = repoRoot();
    const cwd = mkdtempSync(join(tmpdir(), "okm-safe-"));
    const sql = openPostgres(database.url);
    try {
      writeProject(cwd, root, database.url, false);
      const generated = await okm(root, cwd, ["generate"]);
      expect(generated).toContain(".sql");
      const applied = await okm(root, cwd, ["migrate", "apply"]);
      expect(applied).toContain("applied");
      await sql.unsafe(`insert into tasks (id, title) values (1, 'a')`);
      writeProject(cwd, root, database.url, true);
      const pushed = await okm(root, cwd, ["push"]);
      expect(pushed).toContain("applied");
      expect(await indexValid(sql, "public", "tasks_title_idx")).toBe(true);
      const note = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks' and column_name = 'note'
      `;
      expect(note).toHaveLength(1);
      const checked = await okm(root, cwd, ["check"]);
      expect(checked).toBe("ok\n");
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

async function applyPlan(
  schemaName: string,
  id: string,
  before: Catalog,
  after: Catalog,
): Promise<readonly string[]> {
  const plan = planMigration({ before, after, schema: schemaName, name: id });
  await applyTo(schemaName, [migration(id, catalogHash(after), plan.steps)]);
  return plan.steps.map((step) => step.sql);
}

function applyTo(
  schemaName: string,
  migrations: readonly StoredMigration[],
  options?: { readonly lockTimeoutMs?: number; readonly retries?: number },
) {
  return applyTarget({
    url,
    target: schemaName,
    protected: false,
    searchPath: schemaName,
    migrations,
    ...(options?.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
    ...(options?.retries !== undefined ? { retries: options.retries } : {}),
  });
}

function migration(id: string, hash: string, steps: readonly PlanStep[]): StoredMigration {
  return { id, catalogHash: hash, steps };
}

async function indexValid(
  sql: Sql,
  schemaName: string,
  name: string,
): Promise<boolean | undefined> {
  const rows = await sql<{ indisvalid: boolean }[]>`
    select i.indisvalid
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schemaName} and c.relname = ${name}
  `;
  return rows[0]?.indisvalid;
}

async function constraintValidated(
  sql: Sql,
  schemaName: string,
  name: string,
): Promise<boolean | undefined> {
  const rows = await sql<{ convalidated: boolean }[]>`
    select c.convalidated
    from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = ${schemaName} and c.conname = ${name}
  `;
  return rows[0]?.convalidated;
}

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

function writeProject(cwd: string, root: string, database: string, withIndex: boolean): void {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  const indexes = withIndex ? ", { indexes: (columns) => [index(columns.title)] }" : "";
  const note = withIndex ? ", note: t.text().nullable()" : "";
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { index, schema, table, t } from ${pg};`,
      "export const app = schema({",
      "  tables: [",
      `    table("tasks", { id: t.integer().primaryKey(), title: t.text()${note} }${indexes}),`,
      "  ],",
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      `  database: ${JSON.stringify(database)},`,
      "});",
      "",
    ].join("\n"),
  );
}

function alignCheckExpression(author: Catalog, live: Catalog): Catalog {
  return {
    ...author,
    objects: author.objects.map((object) => {
      if (object.kind !== "constraint" || object.definition.constraintKind !== "check") {
        return object;
      }
      const found = live.objects.find(
        (item) => item.kind === "constraint" && item.identity.name === object.identity.name,
      );
      if (found?.kind !== "constraint" || found.definition.expression === undefined) return object;
      return {
        ...object,
        definition: { ...object.definition, expression: found.definition.expression },
      };
    }),
  };
}

async function okm(root: string, cwd: string, args: readonly string[]): Promise<string> {
  const script = [
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    "const lines = [];",
    `await run(${JSON.stringify(args)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => lines.push(text) });`,
    "process.stdout.write(lines.join(''));",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr.length > 0 ? stderr : stdout);
  return stdout;
}

function q(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function catchError(runCase: () => Promise<unknown>): Promise<unknown> {
  try {
    await runCase();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}
