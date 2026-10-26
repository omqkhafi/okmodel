/**
 * N-33: a check reprint on a scratch table sees citext, an enum, a domain,
 * and an extension installed outside public.
 */

import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  "push and check reprint citext, an enum, a domain, and an extension schema",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-reprint-types-"));
    const sql = openPostgres(database.url);
    try {
      await sql.unsafe("create schema extensions");
      await sql.unsafe("create extension citext schema extensions");
      writeConfig(cwd, database.url);
      writeFileSync(join(cwd, "schema.ts"), schemaText());
      const pushed = await cli(cwd, ["push"]);
      expect(pushed.toLowerCase()).not.toContain("does not exist");
      expect(pushed).toMatch(/applied push-1|nothing to apply/);
      const checked = await cli(cwd, ["check"]);
      expect(checked.toLowerCase()).not.toContain("does not exist");
      expect(checked.trimEnd().endsWith("ok")).toBe(true);

      const app = mkdtempSync(join(tmpdir(), "okm-reprint-app-"));
      try {
        await sql.unsafe("create schema app");
        writeConfig(app, database.url, "app");
        writeFileSync(join(app, "schema.ts"), appSchemaText());
        const appPush = await cli(app, ["push"]);
        expect(appPush.toLowerCase()).not.toContain("does not exist");
        expect(appPush).toMatch(/applied push-1/);
        const appCheck = await cli(app, ["check"]);
        expect(appCheck.toLowerCase()).not.toContain("does not exist");
        expect(appCheck.trimEnd().endsWith("ok")).toBe(true);
      } finally {
        rmSync(app, { recursive: true, force: true });
      }
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

function schemaText(): string {
  const pg = source("src/dialects/pg/index.ts");
  const ext = source("src/dialects/pg/ext/citext.ts");
  return [
    `import { schema, sql, table, t } from ${pg};`,
    `import { citext } from ${ext};`,
    'const status = t.enum("status", ["open", "closed"]);',
    'const people = table("people", {',
    "  id: t.integer().primaryKey(),",
    "  email: t.citext(),",
    '}, { checks: { email: (columns) => sql`${columns.email} <> \'x\'` } });',
    'const tasks = table("tasks", {',
    "  id: t.integer().primaryKey(),",
    "  status,",
    '}, { checks: { status: (columns) => sql`${columns.status} <> \'closed\'` } });',
    'const scores = table("scores", {',
    "  id: t.integer().primaryKey(),",
    '  value: t.domain("positive", t.integer(), "VALUE > 0"),',
    "}, { checks: { value: (columns) => sql`${columns.value} < ${100}` } });",
    "export const app = schema({",
    "  tables: [people, tasks, scores],",
    '  extensions: [citext({ schema: "extensions" })],',
    "});",
    "",
  ].join("\n");
}

function appSchemaText(): string {
  const pg = source("src/dialects/pg/index.ts");
  const ext = source("src/dialects/pg/ext/citext.ts");
  return [
    `import { schema, sql, table, t } from ${pg};`,
    `import { citext } from ${ext};`,
    'const notes = table("notes", {',
    "  id: t.integer().primaryKey(),",
    "  body: t.citext(),",
    '}, { checks: { body: (columns) => sql`${columns.body} <> \'x\'` } });',
    "export const app = schema({",
    "  tables: [notes],",
    '  extensions: [citext({ schema: "extensions" })],',
    "});",
    "",
  ].join("\n");
}

function source(path: string): string {
  return JSON.stringify(join(root, path));
}

function writeConfig(cwd: string, url: string, namespace?: string): void {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  const line = namespace === undefined ? "" : `  namespace: ${JSON.stringify(namespace)},\n`;
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(url)},`,
      line.trimEnd(),
      "});",
      "",
    ]
      .filter((item) => item.length > 0)
      .join("\n"),
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
