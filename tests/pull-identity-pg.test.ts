/**
 * N-146: an integer generated-always identity primary key is pulled, and push
 * refuses to drop a column or constraint that pull left under "not pulled yet".
 * Check then says ok without listing those drops.
 */

import { expect } from "bun:test";
import {
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
  "pull keeps an integer identity primary key and push does not drop it",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-identity-"));
    try {
      writeConfig(cwd, database.url);
      linkOkmodel(cwd);
      await seed(
        database.url,
        `create table o (
           id int generated always as identity primary key,
           v text
         );
         insert into o (v) values ('kept');
         create table child (
           id int primary key,
           o_id int not null references o (id)
         )`,
      );
      await cli(cwd, ["pull"]);
      const source = readFileSync(join(cwd, "tables", "o.ts"), "utf8");
      expect(source).toContain("t.integerIdentity()");
      const child = readFileSync(join(cwd, "tables", "child.ts"), "utf8");
      expect(child).toContain(".references(");
      useSourceImports(cwd);
      const pushed = await cli(cwd, ["push"]);
      expect(pushed).toContain("nothing to apply");
      expect(pushed.toLowerCase()).not.toContain("drop column");
      expect(pushed.toLowerCase()).not.toContain("drop constraint");
      const again = await cli(cwd, ["push"]);
      expect(again).toContain("no changes");
      const rows = await query(database.url, "select id::text as id, v from o");
      expect(rows).toEqual([{ id: "1", v: "kept" }]);
      const columns = await query(
        database.url,
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'o' order by column_name",
      );
      expect(columns.map((row) => row["column_name"])).toEqual(["id", "v"]);
      const keys = await query(
        database.url,
        "select conname from pg_constraint where conname = 'o_pkey'",
      );
      expect(keys).toEqual([{ conname: "o_pkey" }]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

postgresTest(
  gate,
  "push refuses a column pull left behind and check does not list that drop",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-identity-"));
    try {
      writeConfig(cwd, database.url);
      linkOkmodel(cwd);
      await seed(
        database.url,
        `create table notes (
           id integer primary key,
           body text not null,
           note xml
         )`,
      );
      const pulled = await cli(cwd, ["pull"]);
      expect(pulled).toContain("notes.note");
      expect(pulled).toContain("not pulled yet");
      useSourceImports(cwd);
      let caught: unknown;
      try {
        await cli(cwd, ["push"]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OkmError);
      expect((caught as OkmError).code).toBe("OKM1897");
      const columns = await query(
        database.url,
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'notes' order by column_name",
      );
      expect(columns.map((row) => row["column_name"])).toEqual(["body", "id", "note"]);
      const checked = await cli(cwd, ["check"]);
      expect(checked).toMatch(/ok\n$/);
      expect(checked.toLowerCase()).not.toContain("drop column");
      expect(checked.toLowerCase()).not.toContain("drop constraint");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

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

function useSourceImports(cwd: string): void {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const ext = JSON.stringify(join(root, "src/dialects/pg/ext/index.ts"));
  const files = [join(cwd, "schema.ts")];
  for (const name of readdirSync(join(cwd, "tables"))) {
    if (name.endsWith(".ts")) files.push(join(cwd, "tables", name));
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

function writeConfig(cwd: string, url: string): void {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      `  schema: "./schema.ts",`,
      `  tables: "./tables",`,
      `  migrations: "./migrations",`,
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
