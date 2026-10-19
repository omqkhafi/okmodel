/**
 * CLI apply, check, and status on CRLF and BOM migration files.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { catalog } from "../src/contracts/catalog/build.js";
import { serializeCatalog } from "../src/contracts/catalog/document.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { CHECK_REPLAY_LIMIT } from "../src/tooling/migrate/check.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "generate, check, status, and apply treat a BOM CRLF migration like LF",
  async () => {
    await withDatabase(async ({ cwd, sql }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`);
      await cli(cwd, ["generate", "init"]);
      await cli(cwd, ["migrate", "apply"]);
      writeSchema(
        cwd,
        `table("items", { id: t.integer().primaryKey(), title: t.text().nullable() })`,
      );
      await cli(cwd, ["generate", "title"]);
      const sqlPath = join(cwd, "migrations", "0002_title.sql");
      expect(existsSync(sqlPath)).toBe(true);
      const original = readFileSync(sqlPath, "utf8");
      expect(original).not.toContain("\r");
      writeFileSync(sqlPath, `\uFEFF${original.replaceAll("\n", "\r\n")}`);
      expect(await cli(cwd, ["migrate", "check"])).toBe(`ok 2 migrations\n${CHECK_REPLAY_LIMIT}\n`);
      expect(await cli(cwd, ["migrate", "status"])).toContain("behind by expand");
      expect(await cli(cwd, ["migrate", "apply"])).toContain("applied 0002_title");
      expect(await columns(sql, "items")).toContain("title");
      expect(await cli(cwd, ["migrate", "status"])).toContain("current");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a hand-written truncate is blocked in LF and in CRLF",
  async () => {
    await withDatabase(async ({ cwd, sql }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`);
      const body = "-- name: hand\n\ntruncate logs;\n";
      writeHand(cwd, body);
      const lf = await rejected(cwd, ["migrate", "apply"]);
      expect(lf).toContain("OKM1510");
      expect(lf).toContain("OKM1542");
      expect(await tables(sql)).toEqual([]);

      writeHand(cwd, body.replaceAll("\n", "\r\n"));
      const crlf = await rejected(cwd, ["migrate", "apply"]);
      expect(crlf).toContain("OKM1510");
      expect(crlf).toContain("OKM1542");

      writeHand(cwd, `\uFEFF${body.replaceAll("\n", "\r\n")}`);
      const bom = await rejected(cwd, ["migrate", "apply"]);
      expect(bom).toContain("OKM1510");
      expect(bom).toContain("OKM1542");
      expect(await tables(sql)).toEqual([]);
    });
  },
  60_000,
);

type Sql = ReturnType<typeof openPostgres>;

async function withDatabase(
  body: (context: { cwd: string; sql: Sql }) => Promise<void>,
): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-crlf-pg-"));
  const sql = openPostgres(database.url);
  try {
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      [
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
        "export default defineConfig({",
        '  schema: "./schema.ts",',
        `  database: ${JSON.stringify(database.url)},`,
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

function writeSchema(cwd: string, tableExpr: string): void {
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
      `export const app = schema({ tables: [${tableExpr}] });`,
      "",
    ].join("\n"),
  );
}

function writeHand(cwd: string, text: string): void {
  const directory = join(cwd, "migrations");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "0002_hand.sql"), text);
  writeFileSync(join(directory, "0002_hand.catalog.json"), serializeCatalog(catalog([])));
}

async function cli(cwd: string, argv: readonly string[]): Promise<string> {
  const script = [
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    "const lines = [];",
    `await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => lines.push(text) });`,
    "process.stdout.write(lines.join(''));",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr.length > 0 ? stderr : stdout);
  return stdout;
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

async function rejected(cwd: string, argv: readonly string[]): Promise<string> {
  try {
    await cli(cwd, argv);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error(`${argv.join(" ")} succeeded`);
}
