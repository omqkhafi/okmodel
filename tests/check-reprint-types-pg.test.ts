/**
 * N-33: a check reprint on a scratch table sees citext, an enum, a domain,
 * and an extension installed outside public.
 *
 * The matrix is generate init, migrate apply, check, push, and migrate
 * check. Each of those must not report `type "..." does not exist`.
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
  "generate, apply, check, push, and migrate check reprint citext, an enum, a domain, and an extension schema",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-reprint-types-"));
    const sql = openPostgres(database.url);
    try {
      writeConfig(cwd, database.url);
      writeFileSync(join(cwd, "schema.ts"), schemaText());
      await expectMatrix(cwd);

      const app = mkdtempSync(join(tmpdir(), "okm-reprint-app-"));
      try {
        await sql.unsafe("drop extension if exists citext cascade");
        await sql.unsafe("drop schema if exists extensions cascade");
        writeConfig(app, database.url, "app");
        writeFileSync(join(app, "schema.ts"), appSchemaText());
        await expectMatrix(app);
      } finally {
        rmSync(app, { recursive: true, force: true });
      }
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  180_000,
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
    "}, { checks: { email: (columns) => sql`${columns.email} <> 'x'` } });",
    'const tasks = table("tasks", {',
    "  id: t.integer().primaryKey(),",
    "  status,",
    "}, { checks: { status: (columns) => sql`${columns.status} <> 'closed'` } });",
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
    "}, { checks: { body: (columns) => sql`${columns.body} <> 'x'` } });",
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

async function expectMatrix(cwd: string): Promise<void> {
  const generated = await cli(cwd, ["generate", "init"]);
  expect(generated.toLowerCase()).not.toContain("does not exist");
  expect(generated).toContain(".sql");
  const checkedFirst = await cli(cwd, ["migrate", "check"]);
  expect(checkedFirst.toLowerCase()).not.toContain("does not exist");
  expect(checkedFirst).toMatch(/^ok \d+ migrations/);
  const applied = await cli(cwd, ["migrate", "apply"]);
  expect(applied.toLowerCase()).not.toContain("does not exist");
  expect(applied).toContain("applied");
  const checked = await cli(cwd, ["check"]);
  expect(checked.toLowerCase()).not.toContain("does not exist");
  expect(checked.trimEnd().endsWith("ok")).toBe(true);
  const pushed = await cli(cwd, ["push"]);
  expect(pushed.toLowerCase()).not.toContain("does not exist");
  expect(pushed).toMatch(/applied push-1|nothing to apply|no changes/);
  const replayed = await cli(cwd, ["migrate", "check"]);
  expect(replayed.toLowerCase()).not.toContain("does not exist");
  expect(replayed).toMatch(/^ok \d+ migrations/);
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
