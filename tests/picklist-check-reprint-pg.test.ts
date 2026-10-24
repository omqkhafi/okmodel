/**
 * Picklist and table-check reprints vs `pg_get_constraintdef` (R2, #399).
 *
 * generate init → migrate check → migrate apply → migrate check → okm check,
 * then a second generate writes nothing. Covers text and varchar picklists,
 * table `IN (...)` checks with and without column handles, and adding a
 * picklist to a populated table (Q2).
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

const cases: readonly {
  readonly name: string;
  readonly schema: string;
  readonly seed?: string;
}[] = [
  {
    name: "picklist on text",
    schema: [
      `import { schema, table, t } from ${source("src/dialects/pg/index.ts")};`,
      'export const app = schema({ tables: [table("tasks", {',
      "  id: t.integer().primaryKey(),",
      '  status: t.text().picklist(["draft", "active", "done"]),',
      "})] });",
      "",
    ].join("\n"),
  },
  {
    name: "picklist on varchar(n) with default",
    schema: [
      `import { schema, table, t } from ${source("src/dialects/pg/index.ts")};`,
      'export const app = schema({ tables: [table("tasks", {',
      "  id: t.integer().primaryKey(),",
      '  status: t.varchar(20).picklist(["draft", "active", "done"]).default("draft"),',
      "})] });",
      "",
    ].join("\n"),
  },
  {
    name: "table check written as IN (...)",
    schema: [
      `import { schema, table, t, sql } from ${source("src/dialects/pg/index.ts")};`,
      'export const app = schema({ tables: [table("tasks", {',
      "  id: t.integer().primaryKey(),",
      "  status: t.text(),",
      "}, {",
      "  checks: {",
      "    status_ok: (columns) => sql`${columns.status} IN ('draft', 'active', 'done')`,",
      "  },",
      "})] });",
      "",
    ].join("\n"),
  },
  {
    name: "table check with no column handle",
    schema: [
      `import { schema, table, t, sql } from ${source("src/dialects/pg/index.ts")};`,
      'export const app = schema({ tables: [table("tasks", {',
      "  id: t.integer().primaryKey(),",
      "  status: t.text(),",
      "}, {",
      "  checks: {",
      "    status_ok: () => sql`status IN ('draft', 'active', 'done')`,",
      "  },",
      "})] });",
      "",
    ].join("\n"),
  },
];

for (const item of cases) {
  postgresTest(
    gate,
    `${item.name}: generate, migrate check, apply, check, generate empty`,
    async () => {
      const database = await createIsolatedDatabase();
      const cwd = mkdtempSync(join(tmpdir(), "okm-picklist-check-"));
      try {
        writeFileSync(join(cwd, "schema.ts"), item.schema);
        writeConfig(cwd, database.url);
        expect(await okm(cwd, ["generate", "init"])).toContain(".sql");
        expect(await okm(cwd, ["migrate", "check"])).toMatch(/^ok \d+ migrations/);
        expect(await okm(cwd, ["migrate", "apply"])).toContain("applied");
        expect(await okm(cwd, ["migrate", "check"])).toMatch(/^ok \d+ migrations/);
        expect(await okm(cwd, ["check"])).toContain("ok");
        expect(await okm(cwd, ["generate"])).toBe("no changes\n");
        expect(await okm(cwd, ["check"])).toContain("ok");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        await database.close();
      }
    },
    120_000,
  );
}

postgresTest(
  gate,
  "push of a varchar picklist and an IN check leaves check with no difference",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-picklist-push-"));
    try {
      writeFileSync(
        join(cwd, "schema.ts"),
        [
          `import { schema, table, t, sql } from ${source("src/dialects/pg/index.ts")};`,
          'export const app = schema({ tables: [table("tasks", {',
          "  id: t.integer().primaryKey(),",
          '  status: t.varchar(20).picklist(["draft", "active", "done"]).default("draft"),',
          "  code: t.varchar(10),",
          "}, {",
          "  checks: {",
          "    code_ok: (columns) => sql`${columns.code} IN ('aa', 'bb')`,",
          "  },",
          "})] });",
          "",
        ].join("\n"),
      );
      writeConfig(cwd, database.url);
      expect(await okm(cwd, ["push"])).toContain("applied");
      expect(await okm(cwd, ["check"])).toContain("ok");
      expect(await okm(cwd, ["push"])).toContain("no changes");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "picklist added to an existing table with rows applies without override",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-picklist-rows-"));
    const sql = openPostgres(database.url);
    try {
      writeFileSync(
        join(cwd, "schema.ts"),
        [
          `import { schema, table, t } from ${source("src/dialects/pg/index.ts")};`,
          'export const app = schema({ tables: [table("tasks", {',
          "  id: t.integer().primaryKey(),",
          "  title: t.text(),",
          "})] });",
          "",
        ].join("\n"),
      );
      writeConfig(cwd, database.url);
      expect(await okm(cwd, ["generate", "init"])).toContain(".sql");
      expect(await okm(cwd, ["migrate", "check"])).toMatch(/^ok \d+ migrations/);
      expect(await okm(cwd, ["migrate", "apply"])).toContain("applied");
      await sql.unsafe(`insert into tasks (id, title) values (1, 'a'), (2, 'b')`);

      writeFileSync(
        join(cwd, "schema.ts"),
        [
          `import { schema, table, t } from ${source("src/dialects/pg/index.ts")};`,
          'export const app = schema({ tables: [table("tasks", {',
          "  id: t.integer().primaryKey(),",
          "  title: t.text(),",
          '  status: t.varchar(20).picklist(["draft", "active", "done"]).default("draft"),',
          "})] });",
          "",
        ].join("\n"),
      );
      expect(await okm(cwd, ["generate", "add_status"])).toContain("add_status");
      expect(await okm(cwd, ["migrate", "check"])).toMatch(/^ok \d+ migrations/);
      expect(await okm(cwd, ["migrate", "apply"])).toContain("applied");
      const statuses = await sql<{ status: string }[]>`select status from tasks order by id`;
      expect(statuses.map((row) => row.status)).toEqual(["draft", "draft"]);
      expect(await okm(cwd, ["migrate", "check"])).toMatch(/^ok \d+ migrations/);
      expect(await okm(cwd, ["check"])).toContain("ok");
      expect(await okm(cwd, ["generate"])).toBe("no changes\n");
    } finally {
      await sql.end({ timeout: 5 });
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
