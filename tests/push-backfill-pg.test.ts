/**
 * `okm push` runs a volatile-default fill through the batched backfill runner.
 *
 * Three existing rows and `batchSize: 1` must record three batches in
 * `okm_backfill`. A single `UPDATE` of all three rows is a miss.
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

postgresTest(
  gate,
  "okm push fills a volatile default one batch at a time",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-push-"));
    const sql = openPostgres(database.url);
    try {
      writeProject(cwd, database.url, false);
      await cli(cwd, ["generate", "init"]);
      await cli(cwd, ["migrate", "apply"]);
      await sql.unsafe(`insert into items (id, title) values (1, 'a'), (2, 'b'), (3, 'c')`);
      writeProject(cwd, database.url, true);
      const text = await cli(cwd, ["push"]);
      expect(text).toMatch(/applied push-\d+/);
      const progress = await sql<{ batches: string; rows: string }[]>`
        select batches::text as batches, rows_touched::text as rows
        from okm_backfill
        where migration_id like 'push-%'
      `;
      expect(progress).toHaveLength(1);
      // batchSize 1 over three rows needs at least three UPDATE batches; a
      // final empty probe may bump the counter once more.
      expect(Number(progress[0]?.batches)).toBeGreaterThanOrEqual(3);
      expect(Number(progress[0]?.rows)).toBe(3);
      const filled = await sql<
        { n: string }[]
      >`select count(*)::text as n from items where token is not null`;
      expect(filled[0]?.n).toBe("3");
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

function writeProject(cwd: string, url: string, token: boolean): void {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  const columns = token
    ? `id: t.integer().primaryKey(), title: t.text(), token: t.uuid().defaultSql("gen_random_uuid()")`
    : `id: t.integer().primaryKey(), title: t.text()`;
  writeFileSync(
    join(cwd, "schema.ts"),
    `import { schema, t, table } from ${pg};\nexport const app = schema({ tables: [table("items", { ${columns} })] });\n`,
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(url)},`,
      "  backfill: { batchSize: 1 },",
      "});",
      "",
    ].join("\n"),
  );
}

async function cli(cwd: string, argv: readonly string[]): Promise<string> {
  const script = [
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    "const lines = [];",
    `await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => lines.push(text) });`,
    "process.stdout.write(lines.join(''));",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr.length > 0 ? stderr : stdout);
  return stdout;
}
