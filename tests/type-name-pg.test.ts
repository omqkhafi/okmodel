/**
 * Live type spellings after push.
 *
 * The seven columns are the spellings `format_type` reprints differently
 * from the schema. The timestamps trait uses the same `timestamptz` column
 * path, so its check is the same comparison.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { projectHead } from "../src/tooling/migrate/project.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "a table of every reprinted type plans to no steps after push, in both directions",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = project(repoRoot(), database.url, spellingsSchema);
    const sql = openPostgres(database.url);
    try {
      await run(["push"], { cwd, stdout: () => undefined });
      await expectNoDrift(cwd, sql);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "timestamps enforcement plans to no steps after push, in both directions",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = project(repoRoot(), database.url, timestampsSchema);
    const sql = openPostgres(database.url);
    try {
      await run(["push"], { cwd, stdout: () => undefined });
      await expectNoDrift(cwd, sql);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

const spellingsSchema = [
  "export const app = schema({",
  "  tables: [",
  '    table("notes", {',
  "      id: t.integer().primaryKey(),",
  "      name: t.varchar(20),",
  "      code: t.char(4),",
  "      at: t.timestamptz(),",
  "      day: t.timestamp(),",
  "      clock: t.time(),",
  "      zone: t.timetz(),",
  "    }),",
  "  ],",
  "});",
].join("\n");

const timestampsSchema = [
  "export const app = schema({",
  '  casing: "snake",',
  "  tables: [",
  "    table(",
  '      "notes",',
  "      { id: t.text().primaryKey() },",
  '      { traits: [timestamps({ enforce: "trigger" })] },',
  "    ),",
  "  ],",
  "});",
].join("\n");

async function expectNoDrift(cwd: string, sql: Sql): Promise<void> {
  const head = await projectHead(cwd);
  const live = await introspectSchema(queryOf(sql), "public", "public");
  const back = planMigration({ before: live, after: head.catalog, name: "check" }).steps.map(
    (step) => step.sql,
  );
  const forward = planMigration({
    before: head.catalog,
    after: live,
    name: "forward",
  }).steps.map((step) => step.sql);
  expect(back).toEqual([]);
  expect(forward).toEqual([]);
}

function project(root: string, url: string, body: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-type-"));
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const traits = JSON.stringify(join(root, "src/runtime/traits/index.ts"));
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, table, t } from ${pg};`,
      `import { timestamps } from ${traits};`,
      body,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      `  database: ${JSON.stringify(url)},`,
      "});",
      "",
    ].join("\n"),
  );
  return cwd;
}

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
