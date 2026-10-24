/**
 * A lock timeout during `okm migrate check` does not tell you to fix the step
 * and run apply (N-101).
 *
 * The replay waits on a lock another session holds. The fix says to run the
 * check again when that lock is free.
 */

import { expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "a lock timeout during migrate check says to retry the check",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-check-lock-"));
    const sql = openPostgres(database.url);
    await sql.unsafe("create schema held");
    await sql.unsafe("create table held.gate (id integer primary key)");
    const held = await sql.reserve();
    try {
      writeConfig(cwd, database.url);
      writeSchema(cwd);
      await cli(cwd, ["generate", "init"]);
      const file = readdirSync(join(cwd, "migrations")).find((name) => name.endsWith(".sql"));
      if (file === undefined) throw new Error("generate init wrote no SQL");
      const path = join(cwd, "migrations", file);
      writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()}\n\nlock table held.gate;\n`);
      await held.unsafe("begin");
      await held.unsafe("lock table held.gate in access exclusive mode");
      const error = await rejected(["migrate", "check"], cwd);
      expect(error.message.toLowerCase()).toContain("lock timeout");
      expect(error.fix.summary).toBe(
        "A lock timed out. Run okm migrate check again when that lock is free. The step does not need a change.",
      );
    } finally {
      await held.unsafe("rollback").catch(() => undefined);
      held.release();
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

function writeSchema(cwd: string): void {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${pg};`,
      "export const app = schema({",
      `  tables: [table("items", { id: t.integer().primaryKey(), title: t.text() })],`,
      "});",
      "",
    ].join("\n"),
  );
}

function writeConfig(cwd: string, url: string): void {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      `  schema: "./schema.ts",`,
      `  migrations: "./migrations",`,
      `  database: ${JSON.stringify(url)},`,
      "  timeouts: { lock: 400 },",
      "});",
      "",
    ].join("\n"),
  );
}

async function cli(cwd: string, argv: readonly string[]): Promise<void> {
  await run(argv, { cwd, stdout: () => undefined });
}

async function rejected(argv: readonly string[], cwd: string): Promise<OkmError> {
  try {
    await run(argv, { cwd, stdout: () => undefined });
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error(`expected ${argv.join(" ")} to fail`);
}
