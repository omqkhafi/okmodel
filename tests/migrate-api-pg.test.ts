/**
 * Programmatic plan, apply, and status against Postgres (D298).
 *
 * The returned text matches `okm migrate plan`, `apply`, and `status`.
 * A failed apply resumes from the same step ids.
 */

import { expect } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { apply, plan, status } from "../src/tooling/migrate/api.js";
import { run } from "../src/tooling/migrate/commands.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "plan, apply, and status match the CLI and resume after a failed step",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-api-"));
    try {
      writeConfig(cwd, database.url);
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey(), title: t.text() })`);

      const planned = await plan("init", { cwd });
      const cliPlan = await cli(cwd, ["migrate", "plan", "init"]);
      expect(cliPlan.startsWith(planned.text)).toBe(true);
      expect(planned.steps.length).toBeGreaterThan(0);
      for (const step of planned.steps) {
        expect(step.id.startsWith("init:")).toBe(true);
        expect(["expand", "contract", "unclassified"]).toContain(step.class);
        expect(step.sql.length).toBeGreaterThan(0);
      }
      const document = JSON.parse(planned.json) as { steps: { sql: string }[] };
      expect(document.steps.map((step) => step.sql)).toEqual(planned.steps.map((step) => step.sql));

      await cli(cwd, ["generate", "init"]);
      const before = await status({ cwd });
      expect(before[0]?.text).toBe(await cli(cwd, ["migrate", "status"]));
      expect(before[0]?.compatibility).toBe("pending");
      expect(before[0]?.pending.length).toBeGreaterThan(0);

      const first = await apply({ cwd });
      expect(first.text).toContain("applied");
      expect(first.applied.length).toBeGreaterThan(0);
      expect((await status({ cwd }))[0]?.compatibility).toBe("up to date");

      const headCatalog = join(cwd, "migrations", `${sqlStem(cwd)}.catalog.json`);
      copyFileSync(headCatalog, join(cwd, "migrations", "0002_resume.catalog.json"));
      const failingSql = [
        "-- class: expand",
        "-- name: resume",
        "",
        "-- class: expand",
        "-- action: ddl",
        "-- lock: ACCESS SHARE",
        "select 1;",
        "",
        "-- class: expand",
        "-- action: ddl",
        "-- lock: ACCESS SHARE",
        "select 1 / 0;",
        "",
      ].join("\n");
      writeFileSync(join(cwd, "migrations", "0002_resume.sql"), failingSql);

      const failed = await catchError(() => apply({ cwd }));
      expect(failed.message).toContain("failed at step");
      const mid = await status({ cwd });
      expect(mid[0]?.compatibility).toBe("pending");
      expect(mid[0]?.pending).toContain("0002_resume:1");
      expect(mid[0]?.text).toBe(await cli(cwd, ["migrate", "status"]));

      writeFileSync(
        join(cwd, "migrations", "0002_resume.sql"),
        failingSql.replace("select 1 / 0;", "select 1;"),
      );
      const resumed = await apply({ cwd });
      expect(resumed.text).toContain("applied");
      expect(resumed.applied).toContain("0002_resume");
      expect(await cli(cwd, ["migrate", "apply"])).toContain("nothing to apply");
      const after = await status({ cwd });
      expect(after[0]?.compatibility).toBe("up to date");
      expect(after[0]?.pending).toEqual([]);
      expect(after[0]?.text).toBe(await cli(cwd, ["migrate", "status"]));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

postgresTest(
  gate,
  "plan and status accept an absolute config from another directory",
  async () => {
    const database = await createIsolatedDatabase();
    const project = mkdtempSync(join(tmpdir(), "okm-api-cfg-"));
    const other = mkdtempSync(join(tmpdir(), "okm-api-else-"));
    try {
      writeConfig(project, database.url);
      writeSchema(project, `table("items", { id: t.integer().primaryKey() })`);
      const config = join(project, "okmodel.config.ts");
      const planned = await plan("from-elsewhere", { cwd: other, config });
      expect(planned.steps.length).toBeGreaterThan(0);
      const cliPlan = await cli(other, ["--config", config, "migrate", "plan", "from-elsewhere"]);
      expect(cliPlan.startsWith(planned.text)).toBe(true);
      await cli(other, ["--config", config, "generate", "init"]);
      const rows = await status({ cwd: other, config });
      expect(rows[0]?.compatibility).toBe("pending");
      expect(rows[0]?.text).toBe(await cli(other, ["--config", config, "migrate", "status"]));
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

function sqlStem(cwd: string): string {
  const found = readdirSync(join(cwd, "migrations")).find((file) => file.endsWith(".sql"));
  if (found === undefined) throw new Error("no migration sql");
  return found.slice(0, -".sql".length);
}

async function catchError(body: () => Promise<unknown>): Promise<OkmError> {
  try {
    await body();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

async function cli(cwd: string, argv: readonly string[]): Promise<string> {
  const lines: string[] = [];
  await run(argv, { cwd, stdout: (text) => lines.push(text) });
  return lines.join("");
}

function writeSchema(cwd: string, tables: string): void {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${pg};`,
      "export const app = schema({",
      `  tables: [${tables}],`,
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
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(url)},`,
      "});",
      "",
    ].join("\n"),
  );
}
