/**
 * `okm push` refuses a plan that weakens row-level security (OKM1550, N-40).
 *
 * Push runs no other lint. A plan that drops a policy or disables row-level
 * security stops before any statement, and the message names the way
 * through: generate, review, apply with `-- okm-allow OKM1550: <reason>`.
 */

import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const root = repoRoot();
const CLI_TIMEOUT_MS = 60_000;

const TENANT = [
  `import { rlsTenancy } from ${JSON.stringify(join(root, "src/runtime/tenancy/index.ts"))};`,
  `import { id, schema, table, text } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
  'const notes = table("notes", { id: id({ default: "none" }), title: text() });',
  "export const app = schema({",
  '  casing: "snake",',
  '  tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),',
  "  tables: [notes],",
  "});",
].join("\n");

const WIDER = TENANT.replace(
  'const notes = table("notes", { id: id({ default: "none" }), title: text() });',
  'const notes = table("notes", { id: id({ default: "none" }), title: text(), body: text().nullable() });',
);

const UNSCOPED = [
  `import { id, schema, table, text } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
  'const notes = table("notes", { id: id({ default: "none" }), title: text() });',
  'export const app = schema({ casing: "snake", tables: [notes] });',
].join("\n");

postgresTest(
  gate,
  "okm push refuses a plan that drops a policy, names the way through, and changes nothing",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const cwd = mkdtempSync(join(tmpdir(), "okm-push-rls-"));
    try {
      writeConfig(cwd, database.url);
      writeFileSync(join(cwd, "schema.ts"), TENANT);
      expect(await cli(cwd, ["push"])).toMatch(/applied push-1/);
      const policies = await policyNames(sql);
      expect(policies.length).toBeGreaterThan(0);

      writeFileSync(join(cwd, "schema.ts"), WIDER);
      expect(await cli(cwd, ["push"])).toMatch(/applied push-2/);
      // Dropping the column is OKM1512 in a migration file. Push lints OKM1550 only.

      writeFileSync(join(cwd, "schema.ts"), TENANT);
      expect(await cli(cwd, ["push"])).toMatch(/applied push-3/);

      writeFileSync(join(cwd, "schema.ts"), UNSCOPED);
      const refused = await failure(cwd, ["push"]);
      expect(refused).toContain("OKM1550");
      expect(refused).toMatch(/drops a policy|disables row level security/);
      expect(refused).toContain("okm generate");
      expect(refused).toContain("-- okm-allow OKM1550");
      expect(await policyNames(sql)).toEqual(policies);
      expect(await rowSecurity(sql)).toBe(true);
      expect(await historyIds(sql)).toEqual(["push-1", "push-2", "push-3"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  120_000,
);

type Sql = ReturnType<typeof openPostgres>;

async function policyNames(sql: Sql): Promise<readonly string[]> {
  const rows = await sql<{ name: string }[]>`
    select polname as name from pg_policy where polrelid = 'public.notes'::regclass order by 1
  `;
  return rows.map((row) => row.name);
}

async function rowSecurity(sql: Sql): Promise<boolean> {
  const rows = await sql<{ on: boolean }[]>`
    select relrowsecurity as on from pg_class where oid = 'public.notes'::regclass
  `;
  return rows[0]?.on === true;
}

async function historyIds(sql: Sql): Promise<readonly string[]> {
  const rows = await sql<{ id: string }[]>`
    select distinct migration_id as id from okm_history order by 1
  `;
  return rows.map((row) => row.id);
}

function writeConfig(cwd: string, url: string): void {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(url)},`,
      "});",
      "",
    ].join("\n"),
  );
}

async function spawnCli(
  cwd: string,
  argv: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const script = [
    `import { OkmError } from ${JSON.stringify(join(root, "src/contracts/error.ts"))};`,
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    "const lines = [];",
    "try {",
    `  await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => lines.push(text) });`,
    "  process.stdout.write(lines.join(''));",
    "} catch (error) {",
    "  process.stdout.write(lines.join(''));",
    "  process.stderr.write(error instanceof OkmError ? `error ${error.code}: ${error.message}\\n${error.fix.summary}\\n` : String(error));",
    "  process.exitCode = 1;",
    "}",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), CLI_TIMEOUT_MS);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

async function cli(cwd: string, argv: readonly string[]): Promise<string> {
  const result = await spawnCli(cwd, argv);
  if (result.code !== 0) throw new Error(result.stderr.length > 0 ? result.stderr : result.stdout);
  return result.stdout;
}

async function failure(cwd: string, argv: readonly string[]): Promise<string> {
  const result = await spawnCli(cwd, argv);
  expect(result.code).not.toBe(0);
  return `${result.stdout}${result.stderr}`;
}
