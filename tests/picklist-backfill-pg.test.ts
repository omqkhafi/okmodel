/**
 * A picklist value removed from a table that holds rows (D131, D195, D301).
 *
 * `okm generate --replace` plans the two backfills before the check swap,
 * whether or not the target answers. The planner's own `NOT VALID` then
 * `VALIDATE` pair is not OKM1531 once the backfill precedes it. Apply moves
 * the rows, the check ends validated, and a second plan is empty.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const root = repoRoot();
const UNREACHABLE = "postgres://okm:okm@127.0.0.1:1/okm";

function schemaText(values: string): string {
  return [
    `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
    'export const app = schema({ tables: [table("tasks", {',
    "  id: t.integer().primaryKey(),",
    `  status: t.text().picklist([${values}]),`,
    "})] });",
    "",
  ].join("\n");
}

function writeConfig(cwd: string, database: string): void {
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      `  database: ${JSON.stringify(database)},`,
      "});",
      "",
    ].join("\n"),
  );
}

function okm(cwd: string, args: readonly string[]) {
  const result = spawnSync("bun", [join(root, "src/tooling/cli.ts"), ...args], {
    cwd,
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function steps(cwd: string): string {
  const file = readdirSync(join(cwd, "migrations")).find((name) => name.includes("drop_draft"));
  return readFileSync(join(cwd, "migrations", file ?? ""), "utf8");
}

postgresTest(
  gate,
  "removing a picklist value backfills, generates without override, applies, and plans empty",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-picklist-backfill-"));
    const sql = openPostgres(database.url);
    try {
      writeFileSync(join(cwd, "schema.ts"), schemaText('"draft", "active", "done"'));
      writeConfig(cwd, database.url);
      expect(okm(cwd, ["generate", "init"]).code).toBe(0);
      expect(okm(cwd, ["migrate", "apply"]).code).toBe(0);
      await sql.unsafe(
        `insert into tasks (id, status) values (1, 'draft'), (2, 'active'), (3, 'done')`,
      );

      writeFileSync(join(cwd, "schema.ts"), schemaText('"active", "done"'));
      const flag = ["--replace", "tasks.status.draft=active"];
      const planned = okm(cwd, ["migrate", "plan", "drop_draft", ...flag]);
      expect(planned.code, planned.stderr).toBe(0);
      const kinds = [...planned.stdout.matchAll(/^-- kind: (\S+)$/gm)].map((match) => match[1]);
      expect(kinds).toEqual([
        "backfill-expand",
        "backfill-contract",
        "narrow-check",
        "narrow-check",
        "narrow-check",
      ]);

      const generated = okm(cwd, ["generate", "drop_draft", ...flag]);
      expect(generated.code, generated.stderr).toBe(0);
      expect(generated.stderr).not.toContain("OKM1510");
      expect(generated.stderr).not.toContain("OKM1531");

      const applied = okm(cwd, ["migrate", "apply"]);
      expect(applied.code, applied.stderr).toBe(0);
      const rows = await sql<
        { id: number; status: string }[]
      >`select id, status from tasks order by id`;
      expect(rows.map((row) => row.status)).toEqual(["active", "active", "done"]);
      const check = await sql<{ convalidated: boolean }[]>`
        select convalidated from pg_constraint where conname = 'tasks_status_check'`;
      expect(check.map((row) => row.convalidated)).toEqual([true]);

      expect(okm(cwd, ["generate"]).stdout).toBe("no changes\n");
      const again = okm(cwd, ["migrate", "plan", "again"]);
      expect(again.stdout).toContain("-- no steps");
      expect(okm(cwd, ["check"]).code).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "the same removal with the target unreachable writes the same migration",
  async () => {
    const database = await createIsolatedDatabase();
    const live = mkdtempSync(join(tmpdir(), "okm-picklist-live-"));
    const dark = mkdtempSync(join(tmpdir(), "okm-picklist-dark-"));
    const sql = openPostgres(database.url);
    try {
      for (const cwd of [live, dark]) {
        writeFileSync(join(cwd, "schema.ts"), schemaText('"draft", "active", "done"'));
        writeConfig(cwd, database.url);
        expect(okm(cwd, ["generate", "init"]).code).toBe(0);
      }
      expect(okm(live, ["migrate", "apply"]).code).toBe(0);
      await sql.unsafe(`insert into tasks (id, status) values (1, 'draft'), (2, 'done')`);

      const flag = ["--replace", "tasks.status.draft=active"];
      for (const cwd of [live, dark]) {
        writeFileSync(join(cwd, "schema.ts"), schemaText('"active", "done"'));
      }
      writeConfig(dark, UNREACHABLE);
      const offline = okm(dark, ["generate", "drop_draft", ...flag]);
      expect(offline.code, offline.stderr).toBe(0);
      expect(offline.stderr).toContain(
        "note: target unreachable, so this plan has no row estimates and no live comparison",
      );
      expect(okm(live, ["generate", "drop_draft", ...flag]).code).toBe(0);
      expect(steps(dark)).toBe(steps(live));

      writeConfig(dark, database.url);
      const applied = okm(dark, ["migrate", "apply"]);
      expect(applied.code, applied.stderr).toBe(0);
      const rows = await sql<{ status: string }[]>`select status from tasks order by id`;
      expect(rows.map((row) => row.status)).toEqual(["active", "done"]);
      const check = await sql<{ convalidated: boolean }[]>`
        select convalidated from pg_constraint where conname = 'tasks_status_check'`;
      expect(check.map((row) => row.convalidated)).toEqual([true]);
      expect(okm(dark, ["generate"]).stdout).toBe("no changes\n");
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(live, { recursive: true, force: true });
      rmSync(dark, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);
