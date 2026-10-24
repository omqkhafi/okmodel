/**
 * `IF NOT EXISTS` on a unique index still fails the existing-table lint (N-85).
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "if not exists still refuses a unique index and a unique constraint",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-unique-ine-"));
    const sql = openPostgres(database.url);
    try {
      writeSchema(cwd, database.url, "title: t.text()");
      expect(await okm(cwd, ["generate", "init"])).toContain(".sql");
      expect(await okm(cwd, ["migrate", "apply"])).toContain("applied");
      await sql.unsafe(`insert into tasks (id, title) values (1, 'a'), (2, 'a')`);

      writeSchema(
        cwd,
        database.url,
        "title: t.text()",
        "indexes: (columns) => [index(columns.title).unique()]",
      );
      expect(await rejected(cwd, ["generate", "indexed"])).toContain("OKM1529");
      spliceIfNotExists(cwd);
      expect(await rejected(cwd, ["migrate", "apply"])).toContain("OKM1529");
      dropPending(cwd);

      writeSchema(cwd, database.url, "title: t.text().unique()");
      expect(await rejected(cwd, ["generate", "keyed"])).toContain("OKM1528");
      spliceIfNotExists(cwd);
      expect(await rejected(cwd, ["migrate", "apply"])).toContain("OKM1528");
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

function spliceIfNotExists(cwd: string): void {
  const file = pendingSql(cwd);
  const text = readFileSync(file, "utf8");
  const next = text.replaceAll(
    "create unique index concurrently ",
    "create unique index concurrently if not exists ",
  );
  if (next === text) throw new Error(text);
  writeFileSync(file, next);
}

function pendingSql(cwd: string): string {
  const name = readdirSync(join(cwd, "migrations")).find(
    (file) => file.endsWith(".sql") && !file.startsWith("0001_"),
  );
  if (name === undefined) throw new Error("no pending migration");
  return join(cwd, "migrations", name);
}

function dropPending(cwd: string): void {
  const dir = join(cwd, "migrations");
  for (const name of readdirSync(dir)) {
    if (name.startsWith("0001_")) continue;
    rmSync(join(dir, name));
  }
}

function writeSchema(cwd: string, database: string, title: string, indexes?: string): void {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  const options = indexes === undefined ? "" : `, { ${indexes} }`;
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { index, schema, table, t } from ${pg};`,
      "export default schema({",
      "  tables: [",
      `    table("tasks", { id: t.integer().primaryKey(), ${title} }${options}),`,
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
  const outcome = await spawned(cwd, args);
  if (outcome.code !== 0) {
    throw new Error(outcome.stderr.length > 0 ? outcome.stderr : outcome.stdout);
  }
  return outcome.stdout;
}

async function rejected(cwd: string, args: readonly string[]): Promise<string> {
  const outcome = await spawned(cwd, args);
  if (outcome.code === 0) throw new Error(outcome.stdout);
  return `${outcome.stderr}\n${outcome.stdout}`;
}

async function spawned(
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
    "  } else {",
    "    process.stderr.write(String(error));",
    "  }",
    "  process.exitCode = 1;",
    "}",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout, stderr };
}
