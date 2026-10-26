/**
 * R-1: `okm pull --out` of another target, or of an explicit `--schema`,
 * must not replace the project `.okm/pull.json`. The next push of the
 * original target still refuses OKM1897 and keeps the identity column.
 * `--out` of the same single target still refreshes the record.
 */

import { expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "a scratch pull of another target or schema keeps the project pull record",
  async () => {
    const main = await createIsolatedDatabase();
    const other = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-scratch-"));
    try {
      writeTargets(cwd, main.url, other.url);
      linkOkmodel(cwd);
      await seed(
        main.url,
        `create table o (id smallint generated always as identity primary key, v text);
         insert into o (v) values ('keep');
         create schema s2;
         create table s2.x (id int primary key);`,
      );
      await seed(other.url, `create table y (id int primary key);`);
      await cli(cwd, ["pull", "--target", "default"]);
      const recordPath = join(cwd, ".okm", "pull.json");
      const first = readFileSync(recordPath, "utf8");
      expect(first).toContain("o.id");
      expect(first).toContain("o.o_pkey");

      await cli(cwd, ["pull", "--target", "other", "--out", "scratch"]);
      expect(readFileSync(recordPath, "utf8")).toBe(first);
      expect(existsSync(join(cwd, "scratch", "schema.ts"))).toBe(true);

      await cli(cwd, ["pull", "--target", "default", "--schema", "s2", "--out", "scratch-schema"]);
      expect(readFileSync(recordPath, "utf8")).toBe(first);

      useSourceImports(join(cwd, "db"));
      const refused = await refusal(cwd, ["push", "--target", "default"]);
      expect(refused.code).toBe("OKM1897");
      expect(refused.message).toContain("o.id");
      const columns = await query(
        main.url,
        `select string_agg(column_name, ',' order by ordinal_position) as columns
           from information_schema.columns
          where table_schema = 'public' and table_name = 'o'`,
      );
      expect(columns[0]?.["columns"]).toBe("id,v");
      const keys = await query(
        main.url,
        `select count(*)::text as keys from pg_constraint
          where conrelid = 'public.o'::regclass and contype = 'p'`,
      );
      expect(keys[0]?.["keys"]).toBe("1");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await main.close();
      await other.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "pull --out of the same database still refreshes the pull record",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-refresh-"));
    try {
      writeDatabase(cwd, database.url, "./pulled/schema.ts");
      linkOkmodel(cwd);
      await seed(
        database.url,
        `create table o (id smallint generated always as identity primary key, v text);`,
      );
      await cli(cwd, ["pull", "--out", "pulled"]);
      const recordPath = join(cwd, ".okm", "pull.json");
      expect(readFileSync(recordPath, "utf8")).toContain("o.id");
      await seed(
        database.url,
        `drop table o;
         create table o (id int generated always as identity primary key, v text);`,
      );
      await cli(cwd, ["pull", "--out", "other"]);
      const refreshed = readFileSync(recordPath, "utf8");
      expect(refreshed).not.toContain("o.id");
      expect(existsSync(join(cwd, "pulled", "schema.ts"))).toBe(true);
      expect(existsSync(join(cwd, "other", "schema.ts"))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

async function refusal(cwd: string, argv: readonly string[]): Promise<OkmError> {
  try {
    await cli(cwd, argv);
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    return error as OkmError;
  }
  throw new Error("expected a refusal");
}

async function seed(url: string, statement: string): Promise<void> {
  const sql = openPostgres(url);
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function query(url: string, statement: string): Promise<readonly Record<string, unknown>[]> {
  const sql = openPostgres(url);
  try {
    return await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function useSourceImports(dir: string): void {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const ext = JSON.stringify(join(root, "src/dialects/pg/ext/index.ts"));
  const files = [join(dir, "schema.ts")];
  const tables = join(dir, "tables");
  for (const name of readdirSync(tables)) {
    if (name.endsWith(".ts")) files.push(join(tables, name));
  }
  for (const file of files) {
    const text = readFileSync(file, "utf8")
      .replaceAll('from "okmodel/pg"', `from ${pg}`)
      .replaceAll('from "okmodel/ext"', `from ${ext}`);
    writeFileSync(file, text);
  }
}

function linkOkmodel(cwd: string): void {
  const directory = join(cwd, "node_modules");
  mkdirSync(directory, { recursive: true });
  symlinkSync(root, join(directory, "okmodel"));
}

function writeTargets(cwd: string, main: string, other: string): void {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./db/schema.ts",',
      '  tables: "./db/tables",',
      '  migrations: "./migrations",',
      "  targets: {",
      `    default: ${JSON.stringify(main)},`,
      `    other: ${JSON.stringify(other)},`,
      "  },",
      "});",
      "",
    ].join("\n"),
  );
}

function writeDatabase(cwd: string, url: string, schema: string): void {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      `  schema: ${JSON.stringify(schema)},`,
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(url)},`,
      "});",
      "",
    ].join("\n"),
  );
}

async function cli(cwd: string, argv: readonly string[]): Promise<string> {
  let out = "";
  await run(argv, {
    cwd,
    stdout: (text) => {
      out += text;
    },
  });
  return out;
}
