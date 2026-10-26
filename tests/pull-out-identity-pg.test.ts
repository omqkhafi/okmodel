/**
 * N-151: `okm pull --out ./adopted` still writes `.okm/pull.json` at the
 * project root. Pointing the config at that schema must not let `okm push`
 * drop a smallint or `by default` identity primary key. `okm check` stays ok.
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

const TABLES = [
  "small_always",
  "small_default",
  "int_always",
  "int_default",
  "big_always",
  "big_default",
] as const;

postgresTest(
  gate,
  "pull --out ./adopted records smallint and by-default identities and push keeps them",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-out-"));
    try {
      writeConfig(cwd, database.url, "./adopted/schema.ts", "./adopted/tables");
      linkOkmodel(cwd);
      await seed(database.url, identitySql());
      const pulled = await cli(cwd, ["pull", "--out", "./adopted"]);
      expect(pulled).toContain("not pulled yet");
      const recordPath = join(cwd, ".okm", "pull.json");
      expect(existsSync(recordPath)).toBe(true);
      expect(existsSync(join(cwd, "adopted", ".okm", "pull.json"))).toBe(false);
      const record = readFileSync(recordPath, "utf8");
      for (const table of ["small_always", "small_default", "int_default", "big_default"]) {
        expect(record).toContain(`${table}.id`);
      }
      expect(record).not.toContain("int_always.id");
      expect(record).not.toContain("big_always.id");
      const adopted = join(cwd, "adopted");
      expect(readFileSync(join(adopted, "tables", "int_always.ts"), "utf8")).toContain(
        "t.integerIdentity()",
      );
      expect(readFileSync(join(adopted, "tables", "big_always.ts"), "utf8")).toContain(
        "t.identity()",
      );
      for (const table of ["small_always", "small_default", "int_default", "big_default"]) {
        const source = readFileSync(join(adopted, "tables", `${table}.ts`), "utf8");
        expect(source).not.toContain("t.integerIdentity()");
        expect(source).not.toContain("t.identity()");
        expect(source).not.toContain("t.smallint()");
      }
      useSourceImports(adopted);
      const refused = await refusal(cwd, ["push"]);
      expect(refused.code).toBe("OKM1897");
      expect(refused.message).toContain("small_always.id");
      expect(refused.message).toContain("big_default.id");
      const checked = await cli(cwd, ["check"]);
      expect(checked).toMatch(/ok\n$/);
      expect(checked.toLowerCase()).not.toContain("drop column");
      expect(checked.toLowerCase()).not.toContain("drop constraint");
      const columns = await query(
        database.url,
        `select table_name, column_name
           from information_schema.columns
          where table_schema = 'public' and table_name in (${TABLES.map((name) => `'${name}'`).join(", ")})
          order by table_name, column_name`,
      );
      expect(columns).toEqual(
        [...TABLES].sort().flatMap((table) => [
          { table_name: table, column_name: "id" },
          { table_name: table, column_name: "v" },
        ]),
      );
      const rows = await query(
        database.url,
        `${TABLES.map((table) => `select '${table}' as t, v from ${table}`).join(" union all ")} order by t`,
      );
      expect(rows.map((row) => row["v"])).toEqual([
        "big-always",
        "big-default",
        "int-always",
        "int-default",
        "small-always",
        "small-default",
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

function identitySql(): string {
  const forms = [
    ["small_always", "smallint", "always", "small-always"],
    ["small_default", "smallint", "by default", "small-default"],
    ["int_always", "integer", "always", "int-always"],
    ["int_default", "integer", "by default", "int-default"],
    ["big_always", "bigint", "always", "big-always"],
    ["big_default", "bigint", "by default", "big-default"],
  ] as const;
  return forms
    .map(
      ([table, type, generation, value]) =>
        `create table ${table} (id ${type} generated ${generation} as identity primary key, v text);
         insert into ${table} (v) values ('${value}');`,
    )
    .join("\n");
}

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
  for (const name of readdirSync(join(dir, "tables"))) {
    if (name.endsWith(".ts")) files.push(join(dir, "tables", name));
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

function writeConfig(cwd: string, url: string, schema: string, tables: string): void {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      `  schema: ${JSON.stringify(schema)},`,
      `  tables: ${JSON.stringify(tables)},`,
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
