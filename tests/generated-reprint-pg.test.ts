/**
 * Generated expressions reprint on a scratch column (NEW-2).
 *
 * `generated('("a" + 1)')` is stored by Postgres as `(a + 1)`. migrate check,
 * okm check, and a later generate compare that reprint, not the author quotes.
 */

import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { reprintGenerated } from "../src/dialects/pg/introspect.js";
import { catalogQuery } from "../src/tooling/migrate/drift.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "a quoted generated expression reprints to the text Postgres stores",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const runner = catalogQuery(sql);
      const column = { name: "b", dataType: "integer" };
      const siblings = [{ name: "a", dataType: "integer" }];
      const reprinted = await reprintGenerated(runner, '("a" + 1)', column, siblings);
      expect(reprinted).toBe("(a + 1)");
      expect(await reprintGenerated(runner, reprinted, column, siblings)).toBe(reprinted);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "generated('(\"a\" + 1)') survives migrate check, apply, and okm check",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-generated-"));
    try {
      writeFileSync(
        join(cwd, "schema.ts"),
        [
          `import { schema, table, t } from ${source("src/dialects/pg/index.ts")};`,
          'export const app = schema({ tables: [table("tasks", {',
          "  id: t.integer().primaryKey(),",
          "  a: t.integer(),",
          "  b: t.integer().generated('(\"a\" + 1)'),",
          "})] });",
          "",
        ].join("\n"),
      );
      writeConfig(cwd, database.url);
      expect(await okm(cwd, ["generate", "init"])).toContain(".sql");
      expect(await okm(cwd, ["migrate", "check"])).toMatch(/^ok \d+ migrations/);
      expect(await okm(cwd, ["migrate", "apply"])).toContain("applied");
      expect(await okm(cwd, ["migrate", "check"])).toMatch(/^ok \d+ migrations/);
      expect(await okm(cwd, ["check"])).toContain("ok");
      expect(await okm(cwd, ["generate"])).toBe("no changes\n");
      expect(await okm(cwd, ["push"])).toContain("no changes");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

function source(path: string): string {
  return JSON.stringify(join(root, path));
}

function writeConfig(cwd: string, database: string): void {
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${source("src/tooling/migrate/index.ts")};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      `  database: ${JSON.stringify(database)},`,
      "});",
      "",
    ].join("\n"),
  );
}

async function okm(cwd: string, args: readonly string[]): Promise<string> {
  const script = [
    `import { OkmError } from ${JSON.stringify(join(root, "src/contracts/error.ts"))};`,
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    "const lines = [];",
    "try {",
    `  await run(${JSON.stringify(args)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => lines.push(text) });`,
    "  process.stdout.write(lines.join(''));",
    "} catch (error) {",
    "  process.stdout.write(lines.join(''));",
    "  if (error instanceof OkmError) {",
    "    process.stderr.write(`error ${error.code}: ${error.message}\\n${error.fix.summary}\\n`);",
    "  }",
    "  process.exitCode = 1;",
    "}",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr.length > 0 ? stderr : stdout);
  return stdout;
}
