/**
 * N-33: `okm push` on a fresh database reprints a check before the plan
 * has created `citext`. The scratch table must not fail with
 * `type "public.citext" does not exist`.
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
  "push on a fresh database reprints citext before the extension exists",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-citext-fresh-"));
    const sql = openPostgres(database.url);
    try {
      writeFileSync(join(cwd, "okmodel.config.ts"), configText(database.url));
      writeFileSync(join(cwd, "schema.ts"), schemaText());
      const pushed = await cli(cwd, ["push"]);
      expect(pushed.toLowerCase()).not.toContain("does not exist");
      expect(pushed).toMatch(/applied push-1|nothing to apply|no changes/);
      const checked = await cli(cwd, ["check"]);
      expect(checked.toLowerCase()).not.toContain("does not exist");
      expect(checked.trimEnd().endsWith("ok")).toBe(true);
      const again = await cli(cwd, ["push"]);
      expect(again.toLowerCase()).not.toContain("does not exist");
      expect(again).toMatch(/nothing to apply|no changes/);
      const extensions = await sql<{ name: string }[]>`
        select e.extname as name
        from pg_extension e
        where e.extname = 'citext'
      `;
      expect(extensions.map((row) => row.name)).toEqual(["citext"]);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

function schemaText(): string {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const ext = JSON.stringify(join(root, "src/dialects/pg/ext/citext.ts"));
  return [
    `import { schema, sql, table, t } from ${pg};`,
    `import { citext } from ${ext};`,
    "export const app = schema({",
    "  tables: [",
    "    table(",
    '      "people",',
    "      {",
    "        id: t.identity(),",
    "        email: t.citext(),",
    '        status: t.text().picklist(["draft", "done"]),',
    "      },",
    "      { checks: { email_ok: (columns) => sql`${columns.email} <> ''` } },",
    "    ),",
    "  ],",
    "  extensions: [citext()],",
    "});",
    "",
  ].join("\n");
}

function configText(url: string): string {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  return [
    `import { defineConfig } from ${migrate};`,
    "export default defineConfig({",
    '  schema: "./schema.ts",',
    '  migrations: "./migrations",',
    `  database: ${JSON.stringify(url)},`,
    "});",
    "",
  ].join("\n");
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
