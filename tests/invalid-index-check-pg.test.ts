/**
 * A killed CREATE INDEX CONCURRENTLY leaves an INVALID index and a started
 * step. okm check must not report ok while pg_index.indisvalid is false (N-135).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "okm check reports an INVALID index left after a killed build",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = project(database.url);
    const sql = openPostgres(database.url);
    try {
      await run(["generate", "init"], { cwd, stdout: () => undefined });
      const applied: string[] = [];
      await run(["migrate", "apply"], { cwd, stdout: (text) => applied.push(text) });
      expect(applied.join("")).toContain("applied");
      const before: string[] = [];
      await run(["check"], { cwd, stdout: (text) => before.push(text) });
      expect(before.join("")).toContain("ok");

      const indexes = await sql<{ name: string }[]>`
        select c.relname as name
        from pg_class c
        join pg_index i on i.indexrelid = c.oid
        join pg_class t on t.oid = i.indrelid
        where t.relname = 'tasks' and not i.indisprimary
      `;
      const name = indexes[0]?.name;
      expect(name).toBeDefined();
      await sql`
        update pg_index
        set indisvalid = false
        where indexrelid = (select oid from pg_class where relname = ${name ?? ""})
      `;
      await sql`
        insert into okm_steps (
          migration_id, step_index, kind, sql_hash, state, attempt, started_at
        ) values (
          '0001_init', 1, 'create-index', 'killed', 'started', 1, now()
        )
      `;
      let message = "";
      try {
        await run(["check"], { cwd, stdout: () => undefined });
      } catch (error) {
        message = error instanceof OkmError ? `${error.code}: ${error.message}` : String(error);
      }
      expect(message).toContain("INVALID");
      expect(message).toContain(name ?? "");
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

function project(url: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-invalid-idx-"));
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { index, schema, table, t } from ${pg};`,
      "export default schema({",
      "  tables: [",
      '    table("tasks", {',
      "      id: t.integer().primaryKey(),",
      "      title: t.text(),",
      "    }, {",
      "      indexes: (columns) => [index(columns.title)],",
      "    }),",
      "  ],",
      "});",
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
