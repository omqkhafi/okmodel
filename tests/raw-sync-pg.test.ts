/**
 * `okm raw sync` describes against Postgres and does not execute the statement.
 */

import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createIsolatedDatabase } from "../packages/harness/src/postgres.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import { repoRoot } from "../scripts/root.js";
import { parseLock } from "../src/tooling/describe/lock.js";
import { readRawLock } from "../src/tooling/describe/sync.js";
import { runRawSync } from "../src/tooling/describe/command.js";

const root = repoRoot();
const gate = await loadPostgresGate();

postgresTest(
  gate,
  "okm raw sync writes the lock from a direct connection",
  async () => {
    const database = await createIsolatedDatabase();
    const pool = openPostgres({ url: database.url, max: 1 });
    const cwd = mkdtempSync(join(tmpdir(), "okm-raw-pg-"));
    try {
      await pool.execute("create table tasks (id int primary key, title text)");
      await pool.execute("insert into tasks (id) values (1)");
      writeFileSync(
        join(cwd, "schema.ts"),
        [
          `import { integer, schema, table, text } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
          'export default schema({ tables: [table("tasks", { id: integer().primaryKey(), title: text() })] });',
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(cwd, "okmodel.config.ts"),
        [
          `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
          "export default defineConfig({",
          '  schema: "./schema.ts",',
          `  database: ${JSON.stringify(database.url)},`,
          "});",
          "",
        ].join("\n"),
      );
      mkdirSync(join(cwd, "src"));
      writeFileSync(
        join(cwd, "src", "app.ts"),
        [
          'import { raw } from "okmodel/pg";',
          'export const rows = raw(db, "select id, title from tasks where id = $1", [id]);',
          'export const saved = raw(db, "insert into tasks (id, title) values ($1, $2)", [id, title]);',
          "",
        ].join("\n"),
      );
      const wrote = await runRawSync(cwd, false, { allowProtected: false, allowPooler: false });
      expect(wrote.statements).toBe(2);
      expect(wrote.unchanged).toBe(false);
      const again = await runRawSync(cwd, true, { allowProtected: false, allowPooler: false });
      expect(again.unchanged).toBe(true);
      const lock = parseLock(readRawLock(join(cwd, ".okm")) ?? "");
      const read = Object.values(lock.statements).find((item) => item.kind === "read");
      expect(read?.columns[0]).toEqual({ name: "id", pgType: "integer", nullable: false });
      const count = await pool.execute("select count(*)::int4 from tasks");
      expect(count.rows[0]?.[0]).toBe("1");
    } finally {
      await pool.close();
    }
  },
  30_000,
);
