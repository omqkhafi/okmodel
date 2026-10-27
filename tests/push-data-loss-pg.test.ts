/**
 * `okm push` refuses a plan that would drop rows.
 *
 * The guard is the push transaction, so these cases go through `run()` once.
 * An empty table, a rename, an added object, and a dropped constraint are
 * applied. A column that carried a unique constraint is still refused.
 * OKM1897 stays the code when `.okm/pull.json` still lists the drop.
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

const LOSS_LABELS = ["notes.extra", "acct.id", "tiny.id", "shop"] as const;

postgresTest(
  gate,
  "push refuses every populated drop and names the flag",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-loss-rows-"));
    try {
      writeDatabase(cwd, database.url);
      writeFileSync(join(cwd, "schema.ts"), keptSchema());
      await seed(database.url, populatedSql());
      const refused = await refusal(cwd, ["push"]);
      expect(refused.code).toBe("OKM1898");
      expect(lossLabels(refused.message)).toEqual(expectLabels());
      expect(refused.message).toContain("--allow-data-loss");
      expect(await columnNames(database.url, "notes")).toEqual(["id", "body", "extra"]);
      expect(await columnNames(database.url, "acct")).toEqual(["id", "name"]);
      expect(await columnNames(database.url, "tiny")).toEqual(["id", "name"]);
      expect(await columnNames(database.url, "shop")).toEqual(["id", "note"]);
      expect(await constraintNames(database.url, "emails")).toContain("emails_email_key");
      expect(await rowCount(database.url, "shop")).toBe("1");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "the same plan applies when every table is empty",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-loss-empty-"));
    try {
      writeDatabase(cwd, database.url);
      writeFileSync(join(cwd, "schema.ts"), keptSchema());
      await seed(database.url, populatedSql(false));
      const pushed = await cli(cwd, ["push"]);
      expect(droppedLabels(pushed)).toEqual(expectLabels());
      expect(pushed).toContain("applied push-1");
      expect(await columnNames(database.url, "notes")).toEqual(["id", "body"]);
      expect(await columnNames(database.url, "acct")).toEqual(["name"]);
      expect(await columnNames(database.url, "tiny")).toEqual(["name"]);
      expect(await tableExists(database.url, "shop")).toBe(false);
      expect(await constraintNames(database.url, "emails")).not.toContain("emails_email_key");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "allow-data-loss applies and prints each dropped object",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-loss-allow-"));
    try {
      writeDatabase(cwd, database.url);
      writeFileSync(join(cwd, "schema.ts"), keptSchema());
      await seed(database.url, populatedSql());
      const pushed = await cli(cwd, ["push", "--allow-data-loss"]);
      expect(droppedLabels(pushed)).toEqual(expectLabels());
      expect(pushed).toContain("applied push-1");
      expect(await textValue(database.url, "select body from notes")).toBe("kept");
      expect(await textValue(database.url, "select name from acct")).toBe("kept");
      expect(await textValue(database.url, "select name from tiny")).toBe("kept");
      expect(await textValue(database.url, "select email from emails")).toBe("a@b.c");
      expect(await columnNames(database.url, "notes")).toEqual(["id", "body"]);
      expect(await columnNames(database.url, "acct")).toEqual(["name"]);
      expect(await columnNames(database.url, "tiny")).toEqual(["name"]);
      expect(await tableExists(database.url, "shop")).toBe(false);
      expect(await constraintNames(database.url, "emails")).not.toContain("emails_email_key");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "pull --target other with no --out replaces the record and push still refuses",
  async () => {
    const main = await createIsolatedDatabase();
    const other = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-loss-target-"));
    try {
      writeTargets(cwd, main.url, other.url);
      linkOkmodel(cwd);
      await seed(
        main.url,
        `create table o (id smallint generated always as identity primary key, v text);
         insert into o (v) values ('keep');`,
      );
      await seed(other.url, `create table o (v text);`);
      await cli(cwd, ["pull", "--target", "default"]);
      const recordPath = join(cwd, ".okm", "pull.json");
      const first = readFileSync(recordPath, "utf8");
      expect(first).toContain("o.id");
      expect(first).toContain("o.o_pkey");
      rmSync(join(cwd, "db"), { recursive: true, force: true });
      await cli(cwd, ["pull", "--target", "other"]);
      const replaced = readFileSync(recordPath, "utf8");
      expect(replaced).not.toContain("o.id");
      useSourceImports(join(cwd, "db"));
      const refused = await refusal(cwd, ["push", "--target", "default"]);
      expect(refused.code).toBe("OKM1898");
      expect(lossLabels(refused.message)).toEqual(["o.id"]);
      expect(await textValue(main.url, "select v from o")).toBe("keep");
      expect(await columnNames(main.url, "o")).toEqual(["id", "v"]);
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
  "a reserved column added after pull is OKM1122 on check and push",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-loss-order-col-"));
    try {
      writePullConfig(cwd, database.url);
      linkOkmodel(cwd);
      await seed(database.url, `create table notes (id int primary key, body text);`);
      await cli(cwd, ["pull"]);
      useSourceImports(cwd);
      await seed(database.url, `alter table notes add column "Order" text;`);
      const checked = await refusal(cwd, ["check"]);
      const pushed = await refusal(cwd, ["push"]);
      expect(checked.code).toBe("OKM1122");
      expect(pushed.code).toBe("OKM1122");
      expect(checked.message).toBe(pushed.message);
      expect(checked.message).toBe("column Order is a reserved word.");
      expect(await columnNames(database.url, "notes")).toContain("Order");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "a reserved index added after pull is OKM1122 on check and push",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-loss-order-idx-"));
    try {
      writePullConfig(cwd, database.url);
      linkOkmodel(cwd);
      await seed(database.url, `create table notes (id int primary key, body text);`);
      await cli(cwd, ["pull"]);
      useSourceImports(cwd);
      await seed(database.url, `create index "Order" on notes (body);`);
      const checked = await refusal(cwd, ["check"]);
      const pushed = await refusal(cwd, ["push"]);
      expect(checked.code).toBe("OKM1122");
      expect(pushed.code).toBe("OKM1122");
      expect(checked.message).toBe(pushed.message);
      expect(checked.message).toBe("index Order is a reserved word.");
      const names = await textValue(
        database.url,
        `select string_agg(indexname, ',' order by indexname) from pg_indexes where tablename = 'notes'`,
      );
      expect(names).toContain("Order");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "a rename and an added column are not data loss",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-loss-rename-"));
    try {
      writeDatabase(cwd, database.url);
      writeFileSync(join(cwd, "schema.ts"), titledSchema(false));
      await cli(cwd, ["push"]);
      await seed(database.url, `insert into notes (id, title) values (1, 'hello');`);
      writeFileSync(join(cwd, "schema-next.ts"), titledSchema(true));
      writeDatabase(cwd, database.url, "./schema-next.ts", "okmodel.next.ts");
      const pushed = await cli(cwd, ["push", "--config", "okmodel.next.ts"]);
      expect(pushed).not.toContain("OKM1898");
      expect(pushed).toContain("applied push-2");
      expect(await textValue(database.url, "select heading from notes")).toBe("hello");
      expect(await textValue(database.url, "select note from notes")).toBeNull();
      expect(await columnNames(database.url, "notes")).toEqual(["id", "heading", "note"]);
      const indexes = await textValue(
        database.url,
        `select string_agg(indexname, ',' order by indexname) from pg_indexes where tablename = 'notes'`,
      );
      expect(indexes).toContain("heading");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "a unique constraint with rows drops without the flag and its column still refuses",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-loss-unique-"));
    try {
      writeDatabase(cwd, database.url);
      writeFileSync(join(cwd, "schema.ts"), emailsSchema(true));
      await seed(
        database.url,
        `create table emails (id int primary key, email text unique);
         insert into emails (id, email) values (1, 'a@b.c');`,
      );
      const pushed = await cli(cwd, ["push"]);
      expect(pushed).not.toContain("OKM1898");
      expect(pushed).toContain("applied push-1");
      expect(await constraintNames(database.url, "emails")).not.toContain("emails_email_key");
      expect(await columnNames(database.url, "emails")).toEqual(["id", "email"]);
      expect(await textValue(database.url, "select email from emails")).toBe("a@b.c");
      writeFileSync(join(cwd, "schema-next.ts"), emailsSchema(false));
      writeDatabase(cwd, database.url, "./schema-next.ts", "okmodel.next.ts");
      const refused = await refusal(cwd, ["push", "--config", "okmodel.next.ts"]);
      expect(refused.code).toBe("OKM1898");
      expect(lossLabels(refused.message)).toEqual(["emails.email"]);
      expect(refused.message).toContain("--allow-data-loss");
      expect(await columnNames(database.url, "emails")).toEqual(["id", "email"]);
      expect(await textValue(database.url, "select email from emails")).toBe("a@b.c");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

function emailsSchema(keepEmail: boolean): string {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const columns = keepEmail
    ? "id: t.integer().primaryKey(), email: t.text().nullable()"
    : "id: t.integer().primaryKey()";
  return [
    `import { schema, table, t } from ${pg};`,
    "export const app = schema({",
    "  tables: [",
    `    table("emails", { ${columns} }),`,
    "  ],",
    "});",
    "",
  ].join("\n");
}

function expectLabels(): string[] {
  return [...LOSS_LABELS];
}

function lossLabels(message: string): string[] {
  const match = /would drop (.+)\. Pass --allow-data-loss/.exec(message);
  return match?.[1]?.split(", ") ?? [];
}

function droppedLabels(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("dropped "))
    .map((line) => line.slice("dropped ".length));
}

function populatedSql(rows = true): string {
  const insert = rows
    ? `
      insert into notes (id, body, extra) values (1, 'kept', 'gone');
      insert into acct (name) values ('kept');
      insert into tiny (name) values ('kept');
      insert into shop (id, note) values (1, 'gone');
      insert into emails (id, email) values (1, 'a@b.c');
    `
    : "";
  return `
    create table notes (id int primary key, body text, extra text);
    create table acct (id int generated always as identity primary key, name text);
    create table tiny (id smallint generated always as identity primary key, name text);
    create table shop (id int primary key, note text);
    create table emails (id int primary key, email text unique);
    ${insert}
  `;
}

function keptSchema(): string {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  return [
    `import { schema, table, t } from ${pg};`,
    "export const app = schema({",
    "  tables: [",
    '    table("notes", { id: t.integer().primaryKey(), body: t.text().nullable() }),',
    '    table("acct", { name: t.text().nullable() }),',
    '    table("tiny", { name: t.text().nullable() }),',
    '    table("emails", { id: t.integer().primaryKey(), email: t.text().nullable() }),',
    "  ],",
    "});",
    "",
  ].join("\n");
}

function titledSchema(renamed: boolean): string {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const columns = renamed
    ? 'id: t.integer().primaryKey(), heading: t.text().renamedFrom("title"), note: t.text().nullable()'
    : "id: t.integer().primaryKey(), title: t.text()";
  return [
    `import { index, schema, table, t } from ${pg};`,
    "export const app = schema({",
    "  tables: [",
    renamed
      ? `    table("notes", { ${columns} }, { indexes: (columns) => [index(columns.heading)] }),`
      : `    table("notes", { ${columns} }),`,
    "  ],",
    "});",
    "",
  ].join("\n");
}

async function refusal(cwd: string, argv: readonly string[]): Promise<OkmError> {
  try {
    await cli(cwd, argv);
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    return error as OkmError;
  }
  throw new Error(`expected a refusal for ${argv.join(" ")}`);
}

async function seed(url: string, statement: string): Promise<void> {
  const sql = openPostgres(url);
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function textValue(url: string, statement: string): Promise<string | null> {
  const rows = await query(url, statement);
  const value = rows[0] === undefined ? undefined : Object.values(rows[0])[0];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

async function columnNames(url: string, tableName: string): Promise<string[]> {
  const rows = await query(
    url,
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = '${tableName}'
      order by ordinal_position`,
  );
  return rows.map((row) => String(row["column_name"]));
}

async function constraintNames(url: string, tableName: string): Promise<string[]> {
  const rows = await query(
    url,
    `select conname from pg_constraint
      where conrelid = '${tableName}'::regclass
      order by conname`,
  );
  return rows.map((row) => String(row["conname"]));
}

async function tableExists(url: string, tableName: string): Promise<boolean> {
  const value = await textValue(url, `select to_regclass('public.${tableName}')::text as name`);
  return value !== null;
}

async function rowCount(url: string, tableName: string): Promise<string> {
  return (await textValue(url, `select count(*)::text as n from ${tableName}`)) ?? "0";
}

async function query(url: string, statement: string): Promise<readonly Record<string, unknown>[]> {
  const sql = openPostgres(url);
  try {
    return await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function writeDatabase(
  cwd: string,
  url: string,
  schema = "./schema.ts",
  file = "okmodel.config.ts",
): void {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, file),
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

function writePullConfig(cwd: string, url: string): void {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  tables: "./tables",',
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(url)},`,
      "});",
      "",
    ].join("\n"),
  );
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
