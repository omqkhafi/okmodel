/**
 * Every identifier okmodel emits is quoted, on real Postgres (QA N-39, N-117).
 *
 * Each case runs generate init, migrate check, migrate apply, migrate check,
 * `okm check`, and a second generate that writes nothing. A name that needs
 * quoting (mixed case, a space, a quote, SQL text) has to survive all of it.
 */

import { expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  createIsolatedDatabase,
  openPostgres,
  withPostgresSchema,
} from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import type { Sql } from "postgres";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const root = repoRoot();

const HOSTILE = "text); drop table keep.sentinel; create table zz (a int";

const cases: readonly { readonly name: string; readonly schema: string }[] = [
  {
    name: "mixed-case column handles in a check, an index, and a generated column",
    schema: program("t, table, sql, index", [
      'table("articles", {',
      "  id: t.integer().primaryKey(),",
      "  openedAt: t.timestamptz(),",
      "  publishedAt: t.timestamptz().nullable(),",
      "  tableWidth: t.integer(),",
      "  tableHeight: t.integer(),",
      '  tableArea: t.integer().generated(\'("tableWidth" * "tableHeight")\'),',
      "}, {",
      "  checks: {",
      "    order_ok: (c) => sql`${c.publishedAt} is null or ${c.publishedAt} >= ${c.openedAt}`,",
      "  },",
      "  indexes: (c) => [index(c.publishedAt, c.openedAt)],",
      "}),",
    ]),
  },
  {
    name: "enum and domain names with uppercase, spaces, and quotes",
    schema: program("t, table", [
      'table("people", {',
      "  id: t.integer().primaryKey(),",
      '  mood: t.enum("Mood", ["happy", "sad"]),',
      '  color: t.enum("my color", ["red", "blue"]),',
      '  quoted: t.enum(\'mo"od\', ["a", "b"]),',
      '  score: t.domain("My Score", t.integer(), "VALUE > 0"),',
      "  tag: t.domain('dom\"ain', t.text(), \"VALUE <> ''\"),",
      '  moods: t.enum("Mood", ["happy", "sad"]).array(),',
      "}),",
    ]),
  },
  {
    name: "a type name that contains SQL is one quoted name",
    schema: program("t, table", [
      'table("people", {',
      "  id: t.integer().primaryKey(),",
      `  hostile: t.enum(${JSON.stringify(HOSTILE)}, ["a", "b"]),`,
      "}),",
    ]),
  },
];

for (const item of cases) {
  postgresTest(
    gate,
    `${item.name}: apply, check, and generate are clean`,
    async () => {
      const database = await createIsolatedDatabase();
      const cwd = mkdtempSync(join(tmpdir(), "okm-quote-"));
      const sql = openPostgres(database.url);
      try {
        await sql.unsafe("create schema keep");
        await sql.unsafe("create table keep.sentinel (id integer)");
        writeFileSync(join(cwd, "schema.ts"), item.schema);
        writeConfig(cwd, database.url);
        expect(await okm(cwd, ["generate", "init"])).toContain(".sql");
        expect(await okm(cwd, ["migrate", "check"])).toMatch(/^ok \d+ migrations/);
        expect(await okm(cwd, ["migrate", "apply"])).toContain("applied");
        expect(await okm(cwd, ["migrate", "check"])).toMatch(/^ok \d+ migrations/);
        expect(await okm(cwd, ["check"])).toContain("ok");
        expect(await okm(cwd, ["generate"])).toBe("no changes\n");

        const sentinel =
          await sql`select to_regclass('keep.sentinel') as found, to_regclass('zz') as zz`;
        expect(sentinel[0]?.found).toBe("keep.sentinel");
        expect(sentinel[0]?.zz).toBeNull();
      } finally {
        await sql.end({ timeout: 5 });
        rmSync(cwd, { recursive: true, force: true });
        await database.close();
      }
    },
    120_000,
  );
}

postgresTest(
  gate,
  "a mixed-case check rejects a bad row, and an enum column is added to a table with rows",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-quote-evolve-"));
    const sql = openPostgres(database.url);
    try {
      const first = program("t, table, sql", [
        'table("articles", {',
        "  id: t.integer().primaryKey(),",
        "  openedAt: t.integer(),",
        "  closedAt: t.integer(),",
        "  state: t.text(),",
        "}, {",
        "  checks: { order_ok: (c) => sql`${c.closedAt} >= ${c.openedAt}` },",
        "}),",
      ]);
      writeFileSync(join(cwd, "schema.ts"), first);
      writeConfig(cwd, database.url);
      expect(await okm(cwd, ["generate", "init"])).toContain(".sql");
      expect(await okm(cwd, ["migrate", "apply"])).toContain("applied");
      await sql.unsafe(
        'insert into articles (id, "openedAt", "closedAt", state) values (1, 1, 2, \'new\')',
      );
      let rejected = false;
      try {
        await sql.unsafe(
          'insert into articles (id, "openedAt", "closedAt", state) values (2, 5, 2, \'new\')',
        );
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);

      const second = program("t, table, sql", [
        'table("articles", {',
        "  id: t.integer().primaryKey(),",
        "  openedAt: t.integer(),",
        "  closedAt: t.integer(),",
        "  state: t.text(),",
        '  kind: t.enum("Article State", ["new", "old"]).nullable(),',
        "}, {",
        "  checks: { order_ok: (c) => sql`${c.closedAt} >= ${c.openedAt}` },",
        "}),",
      ]);
      writeFileSync(join(cwd, "schema.ts"), second);
      expect(await okm(cwd, ["generate", "add_kind"])).toContain("add_kind");
      const migrations = readdirSync(join(cwd, "migrations")).filter((file) =>
        file.includes("add_kind"),
      );
      const text = migrations
        .map((file) => readFileSync(join(cwd, "migrations", file), "utf8"))
        .join("\n");
      expect(text).toContain('"Article State"');
      expect(await okm(cwd, ["migrate", "apply"])).toContain("applied");
      expect(await okm(cwd, ["migrate", "check"])).toMatch(/^ok \d+ migrations/);
      expect(await okm(cwd, ["check"])).toContain("ok");
      expect(await okm(cwd, ["generate"])).toBe("no changes\n");
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

const NAMES = ["Mood", "my color", 'mo"od', HOSTILE] as const;

for (const name of NAMES) {
  postgresTest(
    gate,
    `a text column becomes the enum ${JSON.stringify(name)} and a domain, with no SQL run from the name`,
    async () => {
      await withPostgresSchema(async (sql, schemaName) => {
        const kinds = {
          id: t.integer().primaryKey(),
          v: t.enum(name, ["a", "b"]),
          w: t.domain(`${name} dom`, t.text(), "((VALUE <> ''::text))"),
        };
        const before = schema({
          tables: [
            table("people", { id: t.integer().primaryKey(), v: t.text(), w: t.text() }),
            table("others", kinds),
          ],
        });
        const after = schema({ tables: [table("people", kinds), table("others", kinds)] });
        for (const statement of renderCatalog(before.catalog, schemaName)) {
          await sql.unsafe(statement);
        }
        await sql.unsafe("insert into people (id, v, w) values (1, 'a', 'x')");
        await sql.unsafe("drop schema if exists okm_keep cascade");
        await sql.unsafe("create schema okm_keep");
        await sql.unsafe("create table okm_keep.sentinel (id integer)");
        const plan = planMigration({
          before: before.catalog,
          after: after.catalog,
          schema: schemaName,
          name: "retype",
        });
        const text = plan.steps.map((step) => step.sql).join("\n");
        expect(text).toContain(`set data type "${schemaName}"."${name.replaceAll('"', '""')}"`);
        for (const step of plan.steps) await sql.unsafe(step.sql);
        const live = await introspectSchema(queryOf(sql), schemaName, "public");
        const again = planMigration({
          before: live,
          after: after.catalog,
          schema: schemaName,
          name: "again",
        });
        expect(again.steps.map((step) => step.sql)).toEqual([]);
        const found =
          await sql`select to_regclass('okm_keep.sentinel') as found, to_regclass('zz') as zz`;
        expect(found[0]?.found).toBe("okm_keep.sentinel");
        expect(found[0]?.zz).toBeNull();
        await sql.unsafe("drop schema okm_keep cascade");
      });
    },
    60_000,
  );
}

postgresTest(
  gate,
  "the client binds mixed-case enum and domain columns in writes, filters, and arrays",
  async () => {
    const app = schema({
      casing: "snake",
      tables: [
        table("people", {
          id: t.integer().primaryKey(),
          mood: t.enum("Mood", ["happy", "sad"]),
          color: t.enum("my color", ["red", "blue"]).nullable(),
          score: t.domain("My Score", t.integer(), "VALUE > 0"),
          moods: t.enum("Mood", ["happy", "sad"]).array().nullable(),
        }),
      ],
    });
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        await db.people.insert({ id: 1, mood: "happy", color: "red", score: 3, moods: ["sad"] });
        await db.people.update({ where: { id: 1 }, set: { mood: "sad", score: 4, color: null } });
        await db.batch([
          db.people.insert({ id: 2, mood: "happy", score: 1 }),
          db.people.insert({ id: 3, mood: "sad", score: 2 }),
        ]);
        const sad = await db.people.find({ where: { mood: "sad" }, limit: 10 });
        expect(sad.map((row) => row.id).sort((a, b) => a - b)).toEqual([1, 3]);
        const first = await db.people.find({ where: { id: 1 }, limit: 1 });
        expect(first[0]).toMatchObject({ mood: "sad", score: 4, color: null, moods: ["sad"] });
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);

function queryOf(sql: Sql): CatalogQuery {
  return {
    async query(text, params) {
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return rows.map((row) => {
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) copy[key] = value;
        return copy;
      });
    },
  };
}

function program(imports: string, tables: readonly string[]): string {
  return [
    `import { schema, ${imports} } from ${source("src/dialects/pg/index.ts")};`,
    `export const app = schema({ tables: [${tables.join("\n")}] });`,
    "",
  ].join("\n");
}

function source(path: string): string {
  return JSON.stringify(join(root, path));
}

function writeConfig(cwd: string, database: string): void {
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${source("src/tooling/migrate/index.ts")};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      `  database: ${JSON.stringify(database)},`,
      "});",
      "",
    ].join("\n"),
  );
}

async function okm(cwd: string, args: readonly string[]): Promise<string> {
  const script = [
    `import { OkmError } from ${JSON.stringify(join(root, "src/contracts/error.ts"))};`,
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    "const lines = [];",
    "try {",
    `  await run(${JSON.stringify(args)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => lines.push(text) });`,
    "  process.stdout.write(lines.join(''));",
    "} catch (error) {",
    "  process.stdout.write(lines.join(''));",
    "  if (error instanceof OkmError) {",
    "    process.stderr.write(`error ${error.code}: ${error.message}\\n${error.fix.summary}\\n`);",
    "  }",
    "  process.exitCode = 1;",
    "}",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr.length > 0 ? stderr : stdout);
  return stdout;
}
