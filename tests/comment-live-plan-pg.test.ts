/**
 * A comment OKM did not write stays on the database.
 *
 * The declared comment is the truth. A missing comment is unmanaged.
 * `COMMENT … IS NULL` is only for a comment the previous migration snapshot
 * recorded. Push, migrate plan --target, apply, check, and baseline all
 * follow that rule on PostgreSQL 17.
 */

import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Sql } from "postgres";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const root = repoRoot();

const DBA = {
  table: "dba table",
  column: "dba column",
  index: "dba index",
} as const;

const OWNED = {
  table: "okm table",
  column: "okm column",
  index: "okm index",
} as const;

postgresTest(
  gate,
  "a DBA comment on a table, a column, and an index survives push, plan, apply, check, and baseline",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-comment-dba-"));
    const sql = openPostgres(database.url);
    try {
      writeFileSync(join(cwd, "okmodel.config.ts"), configText(database.url));
      writeFileSync(join(cwd, "schema.ts"), schemaText(false, false));
      cli(cwd, ["generate", "init"]);
      cli(cwd, ["migrate", "apply"]);
      await writeDbaComments(sql);
      const pushed = cli(cwd, ["push"]);
      expect(pushed).toContain("no changes");
      expect(await readComments(sql)).toEqual(DBA);
      writeFileSync(join(cwd, "schema.ts"), schemaText(false, true));
      const planned = cli(cwd, ["migrate", "plan", "addnote", "--target", "default"]);
      expect(planned.toLowerCase()).toContain("add column");
      expect(planned.toLowerCase()).not.toMatch(/comment on\b[\s\S]*?\bis null/);
      cli(cwd, ["generate", "addnote"]);
      const migration = readFileSync(latestSql(cwd), "utf8");
      expect(migration.toLowerCase()).not.toMatch(/comment on\b[\s\S]*?\bis null/);
      cli(cwd, ["migrate", "apply"]);
      expect(await readComments(sql)).toEqual(DBA);
      const checked = cli(cwd, ["check"]);
      expect(checked).toContain("OKM2107");
      expect(checked.trimEnd().endsWith("ok")).toBe(true);
      expect(await readComments(sql)).toEqual(DBA);
      const replayed = cli(cwd, ["migrate", "check"]);
      expect(replayed.toLowerCase()).not.toContain("okm1547");
      expect(await readComments(sql)).toEqual(DBA);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }

    const bare = await createIsolatedDatabase();
    const adopted = mkdtempSync(join(tmpdir(), "okm-comment-baseline-"));
    const bareSql = openPostgres(bare.url);
    try {
      writeFileSync(join(adopted, "okmodel.config.ts"), configText(bare.url));
      writeFileSync(join(adopted, "schema.ts"), schemaText(false, false));
      cli(adopted, ["generate", "init"]);
      await bareSql.unsafe(readFileSync(latestSql(adopted), "utf8"));
      await writeDbaComments(bareSql);
      const baselined = cli(adopted, ["migrate", "baseline"]);
      expect(baselined).toContain("baselined");
      expect(baselined.toLowerCase()).not.toContain("okm1858");
      expect(await readComments(bareSql)).toEqual(DBA);
    } finally {
      await bareSql.end({ timeout: 5 });
      rmSync(adopted, { recursive: true, force: true });
      await bare.close();
    }
  },
  180_000,
);

postgresTest(
  gate,
  "a comment OKM wrote is removed when the declaration drops it",
  async () => {
    const applied = await createIsolatedDatabase();
    const applyDir = mkdtempSync(join(tmpdir(), "okm-comment-apply-"));
    const applySql = openPostgres(applied.url);
    try {
      writeFileSync(join(applyDir, "okmodel.config.ts"), configText(applied.url));
      writeFileSync(join(applyDir, "schema.ts"), schemaText(true, false));
      cli(applyDir, ["generate", "init"]);
      cli(applyDir, ["migrate", "apply"]);
      expect(await readComments(applySql)).toEqual(OWNED);
      writeFileSync(join(applyDir, "schema.ts"), schemaText(false, false));
      const planned = cli(applyDir, ["migrate", "plan", "dropc", "--target", "default"]);
      expect(planned.toLowerCase()).toMatch(/comment on table\b[\s\S]*?\bis null/);
      expect(planned.toLowerCase()).toMatch(/comment on column\b[\s\S]*?\bis null/);
      expect(planned.toLowerCase()).toMatch(/comment on index\b[\s\S]*?\bis null/);
      cli(applyDir, ["generate", "dropc"]);
      cli(applyDir, ["migrate", "apply"]);
      expect(await readComments(applySql)).toEqual({ table: null, column: null, index: null });
    } finally {
      await applySql.end({ timeout: 5 });
      rmSync(applyDir, { recursive: true, force: true });
      await applied.close();
    }

    const pushed = await createIsolatedDatabase();
    const pushDir = mkdtempSync(join(tmpdir(), "okm-comment-push-"));
    const pushSql = openPostgres(pushed.url);
    try {
      writeFileSync(join(pushDir, "okmodel.config.ts"), configText(pushed.url));
      writeFileSync(join(pushDir, "schema.ts"), schemaText(true, false));
      cli(pushDir, ["generate", "init"]);
      cli(pushDir, ["migrate", "apply"]);
      expect(await readComments(pushSql)).toEqual(OWNED);
      writeFileSync(join(pushDir, "schema.ts"), schemaText(false, false));
      cli(pushDir, ["push"]);
      expect(await readComments(pushSql)).toEqual({ table: null, column: null, index: null });
    } finally {
      await pushSql.end({ timeout: 5 });
      rmSync(pushDir, { recursive: true, force: true });
      await pushed.close();
    }
  },
  180_000,
);

function schemaText(comments: boolean, extraColumn: boolean): string {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const column = comments ? '.comment("okm column")' : "";
  const index = comments ? '.comment("okm index")' : "";
  const table = comments ? 'comment: "okm table",' : "";
  const extra = extraColumn ? "note: t.text().nullable()," : "";
  return [
    `import { index, schema, table, t } from ${pg};`,
    "export const app = schema({",
    "  tables: [",
    "    table(",
    '      "notes",',
    "      {",
    "        id: t.integer(),",
    `        email: t.text()${column},`,
    `        ${extra}`,
    "      },",
    "      {",
    `        ${table}`,
    "        indexes: (columns) => [",
    `          index(columns.email).name("notes_email_idx")${index},`,
    "        ],",
    "      },",
    "    ),",
    "  ],",
    "});",
    "",
  ].join("\n");
}

function configText(url: string): string {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  return [
    `import { defineConfig } from ${migrate};`,
    "export default defineConfig({",
    '  schema: "./schema.ts",',
    '  migrations: "./migrations",',
    `  database: ${JSON.stringify(url)},`,
    "});",
    "",
  ].join("\n");
}

function cli(cwd: string, argv: readonly string[]): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("NEON_") || key.startsWith("SUPABASE_")) delete env[key];
  }
  const result = spawnSync("bun", [join(root, "src/tooling/cli.ts"), ...argv], {
    cwd,
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${argv.join(" ")} exited ${String(result.status)}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function latestSql(cwd: string): string {
  const files = readdirSync(join(cwd, "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const name = files.at(-1);
  if (name === undefined) throw new Error("no migration sql");
  return join(cwd, "migrations", name);
}

async function writeDbaComments(sql: Sql): Promise<void> {
  await sql.unsafe(`comment on table notes is '${DBA.table}'`);
  await sql.unsafe(`comment on column notes.email is '${DBA.column}'`);
  await sql.unsafe(`comment on index notes_email_idx is '${DBA.index}'`);
}

async function readComments(sql: Sql): Promise<{
  table: string | null;
  column: string | null;
  index: string | null;
}> {
  const rows = await sql<{ kind: string; description: string | null }[]>`
    select 'table' as kind, obj_description('notes'::regclass) as description
    union all
    select 'column', col_description('notes'::regclass, (
      select attnum from pg_attribute
      where attrelid = 'notes'::regclass and attname = 'email'
    ))
    union all
    select 'index', obj_description('notes_email_idx'::regclass)
  `;
  const found = new Map(rows.map((row) => [row.kind, row.description]));
  return {
    table: found.get("table") ?? null,
    column: found.get("column") ?? null,
    index: found.get("index") ?? null,
  };
}
