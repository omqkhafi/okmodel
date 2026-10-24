/**
 * OKM1531 stays when a new column's default or NULL fails the check (N-126).
 *
 * A constant default that passes, and a nullable column whose check allows
 * NULL, still apply.
 */

import { expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "a default outside the check and a check that rejects NULL are OKM1531",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-own-bad-"));
    const sql = openPostgres(database.url);
    try {
      writeSchema(cwd, database.url, ["id: t.integer().primaryKey()", "title: t.text()"]);
      expect(await okm(cwd, ["generate", "init"])).toContain(".sql");
      expect(await okm(cwd, ["migrate", "apply"])).toContain("applied");
      await sql.unsafe(`insert into tasks (id, title) values (1, 'a'), (2, 'b')`);

      writeSchema(
        cwd,
        database.url,
        ["id: t.integer().primaryKey()", "title: t.text()", 'status: t.text().default("nope")'],
        "ok: (columns) => sql`${columns.status} IN ('a', 'b')`",
      );
      const violating = await rejected(cwd, ["generate", "bad_default"]);
      expect(violating).toContain("OKM1531");
      dropPending(cwd);

      writeSchema(
        cwd,
        database.url,
        ["id: t.integer().primaryKey()", "title: t.text()", "status: t.text().nullable()"],
        "present: (columns) => sql`${columns.status} IS NOT NULL`",
      );
      const rejectsNull = await rejected(cwd, ["generate", "rejects_null"]);
      expect(rejectsNull).toContain("OKM1531");
      dropPending(cwd);

      writeSchema(
        cwd,
        database.url,
        ["id: t.integer().primaryKey()", "title: t.text()", 'status: t.text().default("a")'],
        "ok: (columns) => sql`${columns.status} IN ('a', 'b')`",
      );
      expect(await okm(cwd, ["generate", "good_default"])).toContain("good_default");
      expect(await okm(cwd, ["migrate", "apply"])).toContain("applied");
      const statuses = await sql<{ status: string }[]>`select status from tasks order by id`;
      expect(statuses.map((row) => row.status)).toEqual(["a", "a"]);
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
  "a hand-written write or volatile default between add and validate is OKM1531",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-own-sql-"));
    const sql = openPostgres(database.url);
    try {
      writeSchema(cwd, database.url, ["id: t.integer().primaryKey()", "title: t.text()"]);
      expect(await okm(cwd, ["generate", "init"])).toContain(".sql");
      expect(await okm(cwd, ["migrate", "apply"])).toContain("applied");
      await sql.unsafe(`insert into tasks (id, title) values (1, 'a'), (2, 'b')`);

      writeSchema(
        cwd,
        database.url,
        ["id: t.integer().primaryKey()", "title: t.text()", 'status: t.text().default("a")'],
        "ok: (columns) => sql`${columns.status} IN ('a', 'b')`",
      );
      expect(await okm(cwd, ["generate", "hand"])).toContain("hand");
      const file = pendingSql(cwd);
      const original = readFileSync(file, "utf8");
      const tableSql = /alter table\s+(\S+)\s+validate constraint/i.exec(original)?.[1];
      if (tableSql === undefined) throw new Error(original);
      const step = original.lastIndexOf("\n-- class:");
      if (step < 0) throw new Error(original);
      writeFileSync(
        file,
        [
          original.slice(0, step),
          `-- backfill table=${tableSql} key="id" batch=100`,
          `update ${tableSql} set "status" = 'nope' where ($1::text is null or "id" > $1::integer) and ($2::text is null or "id" <= $2::integer);`,
          original.slice(step),
        ].join("\n"),
      );
      expect(await rejected(cwd, ["migrate", "apply"])).toContain("OKM1531");

      const volatile = original.replace(
        /(add column[\s\S]*?)default 'a'/,
        "$1default gen_random_uuid()::text",
      );
      if (!volatile.includes("gen_random_uuid()")) throw new Error(original);
      writeFileSync(file, volatile);
      expect(await rejected(cwd, ["migrate", "apply"])).toContain("OKM1531");

      writeFileSync(file, original);
      expect(await okm(cwd, ["migrate", "apply"])).toContain("applied");
      const statuses = await sql<{ status: string }[]>`select status from tasks order by id`;
      expect(statuses.map((row) => row.status)).toEqual(["a", "a"]);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

function pendingSql(cwd: string): string {
  const dir = join(cwd, "migrations");
  const name = readdirSync(dir).find((file) => file.endsWith(".sql") && !file.startsWith("0001_"));
  if (name === undefined) throw new Error(`no pending migration in ${dir}`);
  return join(dir, name);
}

function dropPending(cwd: string): void {
  const dir = join(cwd, "migrations");
  for (const name of readdirSync(dir)) {
    if (name.startsWith("0001_")) continue;
    rmSync(join(dir, name));
  }
}

function writeSchema(
  cwd: string,
  database: string,
  columns: readonly string[],
  check?: string,
): void {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  const checks = check === undefined ? "" : `, { checks: { ${check} } }`;
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, sql, table, t } from ${pg};`,
      "export const app = schema({",
      "  tables: [",
      `    table("tasks", { ${columns.join(", ")} }${checks}),`,
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
      `  database: ${JSON.stringify(database)},`,
      "});",
      "",
    ].join("\n"),
  );
}

async function okm(cwd: string, args: readonly string[]): Promise<string> {
  const outcome = await run(cwd, args);
  if (outcome.code !== 0)
    throw new Error(outcome.stderr.length > 0 ? outcome.stderr : outcome.stdout);
  return outcome.stdout;
}

async function rejected(cwd: string, args: readonly string[]): Promise<string> {
  const outcome = await run(cwd, args);
  if (outcome.code === 0) throw new Error(outcome.stdout);
  return `${outcome.stderr}\n${outcome.stdout}`;
}

async function run(
  cwd: string,
  args: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
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
  return { code: await proc.exited, stdout, stderr };
}
