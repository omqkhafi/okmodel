/**
 * Adopted databases keep what pull can say, and say what it leaves behind.
 *
 * N-41: enable and force row level security appear in the pull report. After
 * generate init and migrate baseline, okm check does not plan to drop that
 * security, and okm build loads the project.
 */

import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  "pull reports row level security and check after baseline leaves it",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-adopt-"));
    try {
      writeConfig(cwd, database.url);
      linkOkmodel(cwd);
      await seed(
        database.url,
        `create table notes (
           id integer primary key,
           body text not null
         );
         alter table notes enable row level security;
         alter table notes force row level security;
         create policy notes_all on notes for all using (true) with check (true)`,
      );
      const pulled = await cli(cwd, ["pull"]);
      expect(pulled).toContain("policies: 1");
      expect(pulled).toContain("notes.notes_all");
      expect(pulled).toContain("enable row level security");
      expect(pulled).toContain("force row level security");
      expect(pulled).toContain("pull does not write enable or force row level security");
      await cli(cwd, ["generate", "init"]);
      const baselined = await cli(cwd, ["migrate", "baseline"]);
      expect(baselined).toContain("baselined baselined@0001_init");
      const checked = await cli(cwd, ["check"]);
      expect(checked).toMatch(/^ok\b/m);
      expect(checked).not.toContain("disable row level security");
      expect(checked).not.toContain("drop policy");
      const built = await cli(cwd, ["build"]);
      expect(built.length).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

postgresTest(
  gate,
  "pull renames every binding that collides with an okmodel import",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-adopt-"));
    try {
      writeConfig(cwd, database.url);
      linkOkmodel(cwd);
      await seed(
        database.url,
        `create table t (id integer primary key, body text not null);
         create table schema (id integer primary key);
         create table sql (
           id integer primary key,
           body text not null check (body <> '')
         );
         create table index (id integer primary key, body text not null);
         create index index_body on index (body);
         create table extension (id integer primary key);
         create extension citext;
         create table fn (id integer primary key);
         create function fn() returns integer language sql as $$ select 1 $$;
         create function touch_row() returns trigger language plpgsql as $$ begin return new; end $$;
         create table trigger (id integer primary key);
         create trigger touch_row before insert on trigger for each row execute function touch_row();
         create table view (id integer primary key);
         create view rows_view as select id from view;
         create table "materializedView" (id integer primary key);
         create materialized view mat_rows as select id from t with no data`,
      );
      await cli(cwd, ["pull"]);
      const tableT = readFileSync(join(cwd, "tables", "tName.ts"), "utf8");
      expect(tableT).toContain("export const tName");
      expect(tableT).toContain('sqlName: "t"');
      expect(tableT).toContain("t.integer()");
      const schema = readFileSync(join(cwd, "schema.ts"), "utf8");
      for (const binding of [
        "tName",
        "schemaName",
        "sqlName",
        "indexName",
        "extensionName",
        "fnName",
        "triggerName",
        "viewName",
        "materializedViewName",
      ]) {
        expect(schema).toContain(binding);
      }
      expect(schema).not.toMatch(/import \{ schema \} from "\.\/tables\//);
      const built = await cli(cwd, ["build"]);
      expect(built.length).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

postgresTest(
  gate,
  "pull of one schema omits a foreign key to a table outside it and still builds",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-adopt-"));
    try {
      writeConfig(cwd, database.url);
      linkOkmodel(cwd);
      await seed(database.url, crossSchemaSql());
      const pulled = await cli(cwd, ["pull", "--schema", "billing"]);
      expect(pulled).toContain("references a table outside the selected schemas");
      expect(pulled).toContain("invoices_user_id_fkey");
      const source = readFileSync(join(cwd, "tables", "invoices.ts"), "utf8");
      expect(source).not.toContain(".references(");
      const built = await cli(cwd, ["build"]);
      expect(built.length).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

postgresTest(
  gate,
  "pull of both schemas keeps a foreign key and builds",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-adopt-"));
    try {
      writeConfig(cwd, database.url);
      linkOkmodel(cwd);
      await seed(database.url, crossSchemaSql());
      await cli(cwd, ["pull", "--schema", "public", "--schema", "billing"]);
      const source = readFileSync(join(cwd, "tables", "invoices.ts"), "utf8");
      expect(source).toContain(".references(");
      expect(source).toContain("users");
      const built = await cli(cwd, ["build"]);
      expect(built.length).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

postgresTest(
  gate,
  "pull of two schemas with the same table name is OKM1023",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-adopt-"));
    try {
      writeConfig(cwd, database.url);
      linkOkmodel(cwd);
      await seed(
        database.url,
        `create table item (id integer primary key);
         create schema billing;
         create table billing.item (id integer primary key)`,
      );
      let caught: unknown;
      try {
        await cli(cwd, ["pull", "--schema", "public", "--schema", "billing"]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OkmError);
      const error = caught as OkmError;
      expect(error.code).toBe("OKM1023");
      expect(error.message).toContain("item");
      expect(error.message).toContain("schema() has one namespace");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

postgresTest(
  gate,
  "pull does not emit a foreign key to an identity column it did not pull",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-adopt-"));
    try {
      writeConfig(cwd, database.url);
      linkOkmodel(cwd);
      await seed(
        database.url,
        `create table owners (
           id integer generated always as identity primary key,
           name text not null
         );
         create table pets (
           id integer primary key,
           owner_id integer not null references owners (id)
         );
         create table accounts (
           id bigint generated always as identity primary key
         );
         create table sessions (
           id integer primary key,
           account_id bigint not null references accounts (id)
         )`,
      );
      const pulled = await cli(cwd, ["pull"]);
      expect(pulled).toContain("owners.id");
      expect(pulled).toContain("references a column that was not pulled");
      expect(pulled).toContain("pets_owner_id_fkey");
      const pets = readFileSync(join(cwd, "tables", "pets.ts"), "utf8");
      expect(pets).not.toContain(".references(");
      const sessions = readFileSync(join(cwd, "tables", "sessions.ts"), "utf8");
      expect(sessions).toContain(".references(");
      const built = await cli(cwd, ["build"]);
      expect(built.length).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

function crossSchemaSql(): string {
  return `create table users (
            id integer primary key,
            email text not null
          );
          create schema billing;
          create table billing.invoices (
            id integer primary key,
            user_id integer not null references public.users (id)
          )`;
}

async function seed(url: string, statement: string): Promise<void> {
  const sql = openPostgres(url);
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 });
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
