/**
 * `okm pull --casing snake` against Postgres. The default pull stays verbatim.
 */

import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  "pull --casing snake reports keys that do not round-trip, and the default stays verbatim",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-pull-casing-"));
    try {
      writeConfig(cwd, database.url);
      linkOkmodel(cwd);
      const sql = openPostgres(database.url);
      try {
        await sql.unsafe(
          `create table published_notes (
             id integer primary key,
             published_at text,
             a_b_c text,
             "HTML" text
           )`,
        );
      } finally {
        await sql.end({ timeout: 5 });
      }
      const cased = await cli(cwd, ["pull", "--casing", "snake", "--out", "cased"]);
      expect(cased).toContain("sqlName: 2 — cased key does not round-trip to the database name");
      expect(cased).toContain("published_notes.a_b_c");
      expect(cased).toContain("published_notes.HTML");
      const tableFile = readFileSync(join(cwd, "cased/tables/publishedNotes.ts"), "utf8");
      expect(tableFile).toContain("publishedAt: t.text().nullable(),");
      expect(tableFile).toContain('aBC: t.text().sqlName("a_b_c").nullable(),');
      expect(tableFile).toContain('html: t.text().sqlName("HTML").nullable(),');
      expect(readFileSync(join(cwd, "cased/schema.ts"), "utf8")).toContain('casing: "snake"');
      const verbatim = await cli(cwd, ["pull", "--out", "verbatim"]);
      expect(verbatim).not.toContain("does not round-trip");
      const plain = readFileSync(join(cwd, "verbatim/tables/published_notes.ts"), "utf8");
      expect(plain).toContain("published_at: t.text().nullable(),");
      expect(plain).toContain("a_b_c: t.text().nullable(),");
      expect(plain).not.toContain(".sqlName(");
      expect(readFileSync(join(cwd, "verbatim/schema.ts"), "utf8")).not.toContain("casing:");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

function linkOkmodel(cwd: string): void {
  mkdirSync(join(cwd, "node_modules"), { recursive: true });
  symlinkSync(root, join(cwd, "node_modules/okmodel"));
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
