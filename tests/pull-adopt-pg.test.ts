/**
 * Adopted databases keep what pull can say, and say what it leaves behind.
 *
 * N-41: enable and force row level security appear in the pull report. After
 * generate init and migrate baseline, okm check does not plan to drop that
 * security, and okm build loads the project.
 */

import { expect } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

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

postgresTest(
  gate,
  "pull writes a partial index with the builder and no unused imports",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-adopt-"));
    try {
      writeConfig(cwd, database.url);
      linkOkmodel(cwd);
      await seed(
        database.url,
        `create table tasks (
           id integer primary key,
           title text not null
         );
         create index open_title on tasks (title) where title <> '';
         create index folded_title on tasks (title, (lower(title)))`,
      );
      await cli(cwd, ["pull"]);
      const source = readFileSync(join(cwd, "tables", "tasks.ts"), "utf8");
      expect(source).not.toContain("unique() { return this; }");
      expect(source).toContain('index(columns.title).name("open_title")');
      expect(source).toContain("predicate:");
      expect(source).toContain("expression:");
      expect(source).toContain('index(columns.title).name("folded_title")');
      expect(source).not.toMatch(/import \{[^}]*\bsql\b/);
      expect(source).toMatch(/import \{[^}]*\bindex\b/);
      await typecheckPulled(cwd);
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
  "pull --import-ext keeps .ts by default and can write .js or no extension",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-adopt-"));
    try {
      writeConfig(cwd, database.url);
      linkOkmodel(cwd);
      await seed(database.url, `create table notes (id integer primary key, body text not null)`);
      await cli(cwd, ["pull", "--out", "default-ext"]);
      const tsSchema = readFileSync(join(cwd, "default-ext", "schema.ts"), "utf8");
      expect(tsSchema).toContain('from "./tables/notes.ts"');
      const bareBundler = tscResult(join(cwd, "default-ext"), {
        module: "ESNext",
        moduleResolution: "bundler",
        noEmit: true,
        strict: true,
      });
      expect(bareBundler.exitCode).not.toBe(0);
      expect(bareBundler.text).toContain("allowImportingTsExtensions");
      const rewritten = tscResult(join(cwd, "default-ext"), {
        module: "ESNext",
        moduleResolution: "bundler",
        rewriteRelativeImportExtensions: true,
        outDir: "emit",
        strict: true,
      });
      expect(rewritten.exitCode, rewritten.text).toBe(0);
      const emitted = readFileSync(join(cwd, "default-ext", "emit", "schema.js"), "utf8");
      expect(emitted).toContain('from "./tables/notes.js"');
      await cli(cwd, ["pull", "--import-ext", "none", "--out", "none-ext"]);
      const noneSchema = readFileSync(join(cwd, "none-ext", "schema.ts"), "utf8");
      expect(noneSchema).toContain('from "./tables/notes"');
      expect(noneSchema).not.toContain('from "./tables/notes.ts"');
      const noneChecked = tscResult(join(cwd, "none-ext"), {
        module: "ESNext",
        moduleResolution: "bundler",
        noEmit: true,
        strict: true,
      });
      expect(noneChecked.exitCode, noneChecked.text).toBe(0);
      await cli(cwd, ["pull", "--import-ext", "js", "--out", "js-ext"]);
      const jsSchema = readFileSync(join(cwd, "js-ext", "schema.ts"), "utf8");
      expect(jsSchema).toContain('from "./tables/notes.js"');
      const jsChecked = tscResult(join(cwd, "js-ext"), {
        module: "NodeNext",
        moduleResolution: "nodenext",
        noEmit: true,
        strict: true,
      });
      expect(jsChecked.exitCode, jsChecked.text).toBe(0);
      let rejected: unknown;
      try {
        await cli(cwd, ["pull", "--import-ext", "mjs"]);
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(OkmError);
      expect((rejected as OkmError).message).toContain("--import-ext accepts ts, js, or none.");
      const jsDir = join(cwd, "js-ext");
      unlinkSync(join(jsDir, "tsconfig.json"));
      unlinkSync(join(jsDir, "pg-stub.ts"));
      writeConfig(jsDir, database.url);
      linkOkmodel(jsDir);
      const built = await cli(join(cwd, "js-ext"), ["build"]);
      expect(built.length).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

function tscResult(
  cwd: string,
  options: Record<string, unknown>,
): { readonly exitCode: number; readonly text: string } {
  writeFileSync(
    join(cwd, "pg-stub.ts"),
    [
      "export const t: any = {};",
      "export function table(..._args: any[]): any {",
      "  return {};",
      "}",
      "export function schema(..._args: any[]): any {",
      "  return {};",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        skipLibCheck: true,
        paths: { "okmodel/pg": ["./pg-stub.ts"] },
        ...options,
      },
      include: ["schema.ts", "tables/**/*.ts", "pg-stub.ts"],
    })}\n`,
  );
  const ran = Bun.spawnSync({
    cmd: ["bunx", "tsc", "-p", join(cwd, "tsconfig.json"), "--pretty", "false"],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: ran.exitCode ?? 1,
    text: `${ran.stdout.toString()}\n${ran.stderr.toString()}`,
  };
}

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

async function typecheckPulled(cwd: string): Promise<void> {
  const pg = relative(cwd, join(root, "src/dialects/pg/index.ts")).replaceAll("\\", "/");
  const spec = pg.startsWith(".") ? pg : `./${pg}`;
  writeFileSync(
    join(cwd, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          paths: { "okmodel/pg": [spec] },
          strict: true,
          noUnusedLocals: true,
          noEmit: true,
          module: "ESNext",
          moduleResolution: "bundler",
          target: "ESNext",
          allowImportingTsExtensions: true,
          skipLibCheck: true,
        },
        include: ["schema.ts", "tables/**/*.ts"],
      },
      null,
      2,
    ),
  );
  const ran = Bun.spawnSync({
    cmd: ["bunx", "tsc", "-p", join(cwd, "tsconfig.json"), "--pretty", "false"],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = `${ran.stdout.toString()}\n${ran.stderr.toString()}`;
  if (ran.exitCode !== 0) {
    throw new Error(text);
  }
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
