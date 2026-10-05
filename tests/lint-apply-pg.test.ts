/**
 * Apply lints migrations that still have a step missing from `okm_history`.
 *
 * An applied file is left as it ran. A pending error is OKM1510 before any
 * DDL. The first apply, with no history table, lints every file.
 */

import { expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeCatalog } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { schemaDeclarations } from "../src/dialects/pg/declarations.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import { formatPlan, planMigration, type MigrationPlan } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "an applied drop does not block a later clean migration",
  async () => {
    await inDatabase(async ({ cwd, sql }) => {
      const tasks = schema({ tables: [table("tasks", { id: t.identity(), title: t.text() })] });
      const dropped = schema({ tables: [table("tasks", { id: t.identity() })] });
      const noted = schema({
        tables: [table("tasks", { id: t.identity() }), table("notes", { id: t.identity() })],
      });
      const drop = planOf(tasks, dropped, "drop");
      const add = planOf(dropped, noted, "add");
      writeMigration(cwd, "0001_drop", drop.plan, serializeCatalog(dropped.catalog));
      writeMigration(cwd, "0002_add", add.plan, serializeCatalog(noted.catalog));
      await markApplied(sql, "0001_drop", drop.plan.steps.length);
      await run(["migrate", "apply"], { cwd, stdout: () => undefined });
      expect(await tables(sql)).toEqual(["notes", "okm_history", "okm_meta"]);
      expect(await history(sql)).toContain("0001_drop");
      expect(await history(sql)).toContain("0002_add");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a pending drop is refused and nothing is changed",
  async () => {
    await inDatabase(async ({ cwd, sql }) => {
      const empty = schema({ tables: [] });
      const tasks = schema({ tables: [table("tasks", { id: t.identity(), title: t.text() })] });
      const dropped = schema({ tables: [table("tasks", { id: t.identity() })] });
      writeMigration(
        cwd,
        "0001_create",
        planOf(empty, tasks, "create").plan,
        serializeCatalog(tasks.catalog),
      );
      await run(["migrate", "apply"], { cwd, stdout: () => undefined });
      const before = await history(sql);
      writeMigration(
        cwd,
        "0002_drop",
        planOf(tasks, dropped, "drop").plan,
        serializeCatalog(dropped.catalog),
      );
      const error = await failure(() =>
        run(["migrate", "apply"], { cwd, stdout: () => undefined }),
      );
      expect(error.code).toBe("OKM1510");
      expect(error.message).toContain("OKM1512");
      expect(error.message).toContain("0002_drop");
      expect(await history(sql)).toEqual(before);
      expect(await columns(sql, "tasks")).toContain("title");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a pending drop with a reason applies",
  async () => {
    await inDatabase(async ({ cwd, sql }) => {
      const empty = schema({ tables: [] });
      const tasks = schema({ tables: [table("tasks", { id: t.identity(), title: t.text() })] });
      const dropped = schema({ tables: [table("tasks", { id: t.identity() })] });
      writeMigration(
        cwd,
        "0001_create",
        planOf(empty, tasks, "create").plan,
        serializeCatalog(tasks.catalog),
      );
      await run(["migrate", "apply"], { cwd, stdout: () => undefined });
      const drop = planOf(tasks, dropped, "drop");
      writeFileSync(
        join(cwd, "migrations", "0002_drop.sql"),
        formatPlan(drop.plan).replace(
          /^(alter table .*)$/m,
          "-- okm-allow OKM1512: the column is unused\n$1",
        ),
      );
      writeFileSync(
        join(cwd, "migrations", "0002_drop.catalog.json"),
        serializeCatalog(dropped.catalog),
      );
      await run(["migrate", "apply"], { cwd, stdout: () => undefined });
      expect(await columns(sql, "tasks")).not.toContain("title");
      expect(await history(sql)).toContain("0002_drop");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "the first apply lints every pending migration when okm_history does not exist",
  async () => {
    await inDatabase(async ({ cwd, sql }) => {
      const empty = schema({ tables: [] });
      const tasks = schema({ tables: [table("tasks", { id: t.identity(), title: t.text() })] });
      const unique = schema({
        tables: [table("tasks", { id: t.identity(), title: t.text().unique() })],
      });
      writeMigration(
        cwd,
        "0001_create",
        planOf(empty, tasks, "create").plan,
        serializeCatalog(tasks.catalog),
      );
      writeMigration(
        cwd,
        "0002_unique",
        planOf(tasks, unique, "unique").plan,
        serializeCatalog(unique.catalog),
      );
      const error = await failure(() =>
        run(["migrate", "apply"], { cwd, stdout: () => undefined }),
      );
      expect(error.code).toBe("OKM1510");
      expect(error.message).toContain("OKM1528");
      expect(error.message).toContain("0002_unique");
      expect(await tables(sql)).toEqual([]);
    });
  },
  60_000,
);

type Sql = ReturnType<typeof openPostgres>;

async function inDatabase(
  body: (context: { cwd: string; sql: Sql }) => Promise<void>,
): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-lint-apply-"));
  const sql = openPostgres(database.url);
  try {
    mkdirSync(join(cwd, "migrations"));
    writeFileSync(join(cwd, "schema.ts"), "export const unused = 1;\n");
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      [
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
        "export default defineConfig({",
        '  schema: "./schema.ts",',
        '  migrations: "./migrations",',
        `  database: { url: ${JSON.stringify(database.url)} },`,
        "});",
        "",
      ].join("\n"),
    );
    await body({ cwd, sql });
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

function planOf(
  before: ReturnType<typeof schema>,
  after: ReturnType<typeof schema>,
  name: string,
): { plan: MigrationPlan } {
  return {
    plan: planMigration({
      before: before.catalog,
      after: after.catalog,
      renames: schemaDeclarations(after).renames,
      name,
    }),
  };
}

function writeMigration(cwd: string, id: string, plan: MigrationPlan, catalog: string): void {
  writeFileSync(join(cwd, "migrations", `${id}.sql`), formatPlan(plan));
  writeFileSync(join(cwd, "migrations", `${id}.catalog.json`), catalog);
}

async function markApplied(sql: Sql, id: string, steps: number): Promise<void> {
  await sql.unsafe(
    `create table okm_history (
      migration_id text not null,
      step_index integer not null,
      class text not null,
      catalog_hash text not null,
      applied_at timestamptz not null default now(),
      primary key (migration_id, step_index)
    )`,
  );
  for (let index = 0; index < steps; index += 1) {
    await sql`insert into okm_history (migration_id, step_index, class, catalog_hash)
      values (${id}, ${index}, 'contract', 'applied')`;
  }
}

async function tables(sql: Sql): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = 'public'
    order by table_name
  `;
  return rows.map((row) => row.table_name);
}

async function columns(sql: Sql, tableName: string): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${tableName}
    order by column_name
  `;
  return rows.map((row) => row.column_name);
}

async function history(sql: Sql): Promise<string[]> {
  const rows = await sql<{ migration_id: string }[]>`
    select migration_id from okm_history order by migration_id, step_index
  `;
  return rows.map((row) => row.migration_id);
}

async function failure(operation: () => Promise<unknown>): Promise<OkmError> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected an OkmError");
}
