/**
 * N-147: a reserved-word column must not abort `okm pull`.
 *
 * The other tables and columns are written. The reserved column is listed
 * under "not pulled yet". With `.okm/pull.json` present, check and push
 * compare that name and do not run the reserved-word check.
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

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "pull writes the other columns when one column is a reserved word",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-reserved-"));
    try {
      writeConfig(cwd, database.url);
      linkOkmodel(cwd);
      await seed(
        database.url,
        `create table keep (id int primary key, name text);
         insert into keep (id, name) values (1, 'kept');
         create table ranks (
           id int primary key,
           "order" int not null,
           "Order" text,
           note text,
           unique ("order")
         );
         insert into ranks (id, "order", "Order", note) values (1, 4, 'high', 'stay')`,
      );
      const report = await cli(cwd, ["pull"]);
      expect(report).toContain("not pulled yet");
      expect(report).toContain("ranks.order");
      expect(report).toContain("ranks.Order");
      expect(report).toContain("reserved word");
      const keep = readFileSync(join(cwd, "tables", "keep.ts"), "utf8");
      const ranks = readFileSync(join(cwd, "tables", "ranks.ts"), "utf8");
      expect(keep).toContain("name:");
      expect(ranks).toContain("note:");
      expect(ranks).not.toMatch(/["']?order["']?\s*:/i);
      expect(readFileSync(join(cwd, "schema.ts"), "utf8").length).toBeGreaterThan(0);
      const record = readFileSync(join(cwd, ".okm", "pull.json"), "utf8");
      expect(record).toContain("ranks.order");
      expect(record).toContain("ranks.Order");
      useSourceImports(cwd);
      const pushed = await cli(cwd, ["push"]);
      expect(pushed).not.toContain("OKM1122");
      expect(pushed.toLowerCase()).not.toContain("drop column");
      expect(pushed.toLowerCase()).not.toContain("drop constraint");
      const checked = await cli(cwd, ["check"]);
      expect(checked).toMatch(/ok\n$/);
      expect(checked).not.toContain("OKM1122");
      expect(checked.toLowerCase()).not.toContain("drop column");
      const columns = await query(
        database.url,
        `select table_name, column_name
           from information_schema.columns
          where table_schema = 'public' and table_name in ('keep', 'ranks')
          order by table_name, column_name`,
      );
      expect(columns).toEqual([
        { table_name: "keep", column_name: "id" },
        { table_name: "keep", column_name: "name" },
        { table_name: "ranks", column_name: "Order" },
        { table_name: "ranks", column_name: "id" },
        { table_name: "ranks", column_name: "note" },
        { table_name: "ranks", column_name: "order" },
      ]);
      const rows = await query(
        database.url,
        `select "order"::text as n, "Order" as label from ranks`,
      );
      expect(rows).toEqual([{ n: "4", label: "high" }]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

postgresTest(
  gate,
  "an index on a reserved column is kept by check and push",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-reserved-idx-"));
    try {
      writeConfig(cwd, database.url);
      linkOkmodel(cwd);
      await seed(
        database.url,
        `create table shop (
           id int primary key,
           "order" int check ("order" > 0),
           note text
         );
         create index shop_order_idx on shop("order");`,
      );
      const report = await cli(cwd, ["pull"]);
      expect(report).toContain("shop.order");
      expect(report).toContain("shop.shop_order_idx");
      const record = readFileSync(join(cwd, ".okm", "pull.json"), "utf8");
      expect(record).toContain("shop.order");
      expect(record).toContain("shop.shop_order_idx");
      useSourceImports(cwd);
      const pushed = await cli(cwd, ["push"]);
      expect(pushed).not.toContain("OKM1122");
      expect(pushed.toLowerCase()).not.toContain("drop index");
      const checked = await cli(cwd, ["check"]);
      expect(checked).toMatch(/ok\n$/);
      expect(checked).not.toContain("OKM1122");
      const indexes = await query(
        database.url,
        `select string_agg(indexname, ',' order by indexname) as names
           from pg_indexes where tablename = 'shop'`,
      );
      expect(indexes[0]?.["names"]).toBe("shop_order_idx,shop_pkey");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

postgresTest(
  gate,
  "a reserved index name is recorded and push does not drop it",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-reserved-name-"));
    try {
      writeConfig(cwd, database.url);
      linkOkmodel(cwd);
      await seed(
        database.url,
        `create table shop (id int primary key, note text);
         create index "Order" on shop(note);
         alter table shop add constraint "select" check (id > 0);`,
      );
      const report = await cli(cwd, ["pull"]);
      expect(report).toContain("not pulled yet");
      expect(report).toContain("shop.Order");
      expect(report).toContain("shop.select");
      const record = readFileSync(join(cwd, ".okm", "pull.json"), "utf8");
      expect(record).toContain("shop.Order");
      expect(record).toContain('"kind": "index"');
      useSourceImports(cwd);
      const pushed = await cli(cwd, ["push"]);
      expect(pushed).not.toContain("OKM1122");
      expect(pushed.toLowerCase()).not.toContain("drop index");
      const checked = await cli(cwd, ["check"]);
      expect(checked).toMatch(/ok\n$/);
      const indexes = await query(
        database.url,
        `select string_agg(indexname, ',' order by indexname) as names
           from pg_indexes where tablename = 'shop'`,
      );
      expect(indexes[0]?.["names"]).toBe("Order,shop_pkey");
      const constraints = await query(
        database.url,
        `select string_agg(conname, ',' order by conname) as names
           from pg_constraint where conrelid = 'shop'::regclass`,
      );
      expect(String(constraints[0]?.["names"])).toContain("select");
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

async function query(url: string, statement: string): Promise<Record<string, string>[]> {
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
