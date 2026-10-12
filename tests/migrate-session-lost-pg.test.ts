/**
 * A step that kills its own backend must exit.
 *
 * `okm migrate check` and `okm migrate apply` use postgres.js. The result is
 * unavailable or OKM1401, the process does not hang, and the check scratch
 * schema is gone.
 */

import { expect } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { CHECK_SCHEMA_PREFIX } from "../src/tooling/migrate/check.js";

const gate = await loadPostgresGate();
const root = repoRoot();
const KILL = "select pg_terminate_backend(pg_backend_pid());";

postgresTest(
  gate,
  "migrate check exits when a step terminates its backend",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-lost-check-"));
    try {
      writeProject(cwd, database.url);
      expect(spawn(cwd, ["generate", "init"]).exitCode).toBe(0);
      appendFileSync(migrationSql(cwd), `\n\n${KILL}\n`);
      const proc = spawn(cwd, ["migrate", "check"]);
      expectLost(proc);
      expect(await scratchSchemas(database.url)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "migrate apply exits when a later step terminates its backend",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-lost-apply-"));
    try {
      writeProject(cwd, database.url);
      expect(spawn(cwd, ["generate", "init"]).exitCode).toBe(0);
      const first = spawn(cwd, ["migrate", "apply"]);
      expect(first.exitCode).toBe(0);
      const catalog = readdirSync(join(cwd, "migrations")).find((item) =>
        item.endsWith(".catalog.json"),
      );
      if (catalog === undefined) throw new Error("generate wrote no catalog");
      writeFileSync(join(cwd, "migrations", "0002_kill.sql"), `-- name: kill\n\n${KILL}\n`);
      writeFileSync(
        join(cwd, "migrations", "0002_kill.catalog.json"),
        readFileSync(join(cwd, "migrations", catalog)),
      );
      const proc = spawn(cwd, ["migrate", "apply"]);
      expectLost(proc);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

function expectLost(proc: ReturnType<typeof Bun.spawnSync>): void {
  const out = proc.stdout?.toString() ?? "";
  const err = proc.stderr?.toString() ?? "";
  if (proc.signalCode !== null && proc.signalCode !== undefined) {
    throw new Error(`hung ${String(proc.signalCode)}\n${out}\n${err}`);
  }
  if (proc.exitCode === 0) throw new Error(`exit 0\n${out}\n${err}`);
  expect(err).toMatch(/error (?:unavailable|OKM1401):/);
  expect(err).not.toContain("socket.write");
}

function spawn(cwd: string, argv: readonly string[]): ReturnType<typeof Bun.spawnSync> {
  const script = [
    `import { formatFailure, run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    `try { await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => process.stdout.write(text) }); }`,
    "catch (error) { process.stderr.write(formatFailure(error)); process.exitCode = 1; }",
  ].join("\n");
  return Bun.spawnSync(["bun", "-e", script], { timeout: 12_000 });
}

function writeProject(cwd: string, url: string): void {
  const source = (path: string): string => JSON.stringify(join(root, path));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      'export const app = schema({ tables: [table("items", { id: t.integer().primaryKey() })] });',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${source("src/tooling/migrate/index.ts")};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(url)},`,
      "});",
      "",
    ].join("\n"),
  );
}

function migrationSql(cwd: string): string {
  const name = readdirSync(join(cwd, "migrations")).find((item) => item.endsWith(".sql"));
  if (name === undefined) throw new Error("generate wrote no migration");
  return join(cwd, "migrations", name);
}

async function scratchSchemas(url: string): Promise<readonly string[]> {
  const sql = openPostgres(url);
  try {
    const rows = await sql<{ nspname: string }[]>`
      select nspname from pg_namespace where nspname like ${`${CHECK_SCHEMA_PREFIX}%`}
    `;
    return rows.map((row) => row.nspname);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
