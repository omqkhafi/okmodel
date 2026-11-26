/**
 * `okm migrate apply` stops on a weighted step over 100,000 rows, and
 * `--allow-blocking` lets it run. The migration file is written by hand with a
 * `-- weight:` line, the way a later step of the track will generate it.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { okm } from "./cli-output-harness.js";

const gate = await loadPostgresGate();
const root = repoRoot();

function schemaText(columns: readonly string[]): string {
  return [
    `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
    'export const app = schema({ tables: [table("tasks", {',
    "  id: t.integer().primaryKey(),",
    ...columns.map((name) => `  ${name}: t.text().nullable(),`),
    "})] });",
    "",
  ].join("\n");
}

function configText(database: string): string {
  return [
    `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
    "export default defineConfig({",
    '  schema: "./schema.ts",',
    `  database: ${JSON.stringify(database)},`,
    "});",
    "",
  ].join("\n");
}

postgresTest(
  gate,
  "step.blocking: okm migrate apply refuses a weighted step over 100,000 rows and --allow-blocking runs it",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-weight-"));
    const sql = openPostgres(database.url);
    try {
      writeFileSync(join(cwd, "okmodel.config.ts"), configText(database.url));
      writeFileSync(join(cwd, "schema.ts"), schemaText([]));
      expect(okm(cwd, ["generate", "init"]).code).toBe(0);
      expect(okm(cwd, ["migrate", "apply"]).code).toBe(0);
      await sql.unsafe("insert into tasks select g from generate_series(1, 150000) g");

      writeFileSync(join(cwd, "schema.ts"), schemaText(["note"]));
      expect(okm(cwd, ["generate", "add_note"]).code).toBe(0);
      const file = readdirSync(join(cwd, "migrations")).find(
        (name) => name.includes("add_note") && name.endsWith(".sql"),
      );
      if (file === undefined) throw new Error("no migration file");
      const path = join(cwd, "migrations", file);
      const text = readFileSync(path, "utf8");
      expect(text).toContain("-- lock: ");
      writeFileSync(path, text.replace(/(-- lock: [^\n]*\n)/, "$1-- weight: rewrite\n"));

      const refused = okm(cwd, ["migrate", "apply"]);
      expect(refused.code).toBe(4);
      expect(refused.stderr).toContain("OKM1847");
      expect(refused.stderr).toContain("rewrite step on tasks");
      expect(refused.stderr).toContain("Nothing was changed.");
      expect(refused.stderr).toContain("--allow-blocking");
      const none = await sql.unsafe(
        "select count(*)::int as n from information_schema.columns where table_name = 'tasks' and column_name = 'note'",
      );
      expect(none[0]?.n).toBe(0);

      const json = okm(cwd, ["migrate", "apply", "--json"]);
      expect(json.code).toBe(4);
      const body = JSON.parse(json.stdout) as {
        errors: { code: string; retryable: boolean }[];
      };
      expect(body.errors[0]?.code).toBe("OKM1847");
      expect(body.errors[0]?.retryable).toBe(false);

      const allowed = okm(cwd, ["migrate", "apply", "--allow-blocking"]);
      expect(allowed.code).toBe(0);
      const done = await sql.unsafe(
        "select count(*)::int as n from information_schema.columns where table_name = 'tasks' and column_name = 'note'",
      );
      expect(done[0]?.n).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);
