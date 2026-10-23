/**
 * Postgres coverage for planner output that must match the live database
 * after apply: index drop order, foreign key actions, renamed identity
 * tables, enum values, trigger WHEN, and views under a namespace.
 */

import { expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "dropping an indexed column while another index is created drops the index first (N-102)",
  async () => {
    const before = [
      'const tasks = table("tasks", { id: t.integer().primaryKey(), code: t.text(), title: t.text() },',
      "  { indexes: (columns) => [index(columns.code)] });",
    ];
    const after = [
      'const tasks = table("tasks", { id: t.integer().primaryKey(), title: t.text() },',
      "  { indexes: (columns) => [index(columns.title)] });",
    ];
    const database = await createIsolatedDatabase();
    const migrations = project("index-order-migrate");
    const pushed = project("index-order-push");
    try {
      writeConfig(migrations, database.url);
      writeSchema(migrations, before, "tasks");
      await cli(migrations, ["generate", "init"]);
      await cli(migrations, ["migrate", "apply"]);
      writeSchema(migrations, after, "tasks");
      await generateAllowing(migrations);
      await cli(migrations, ["migrate", "apply"]);
      expect(await cli(migrations, ["migrate", "check"])).toContain("ok");
      expect(await cli(migrations, ["check"])).toContain("ok");
    } finally {
      rmSync(migrations, { recursive: true, force: true });
      await database.close();
    }
    const second = await createIsolatedDatabase();
    try {
      writeConfig(pushed, second.url);
      writeSchema(pushed, before, "tasks");
      await cli(pushed, ["push"]);
      writeSchema(pushed, after, "tasks");
      expect(await cli(pushed, ["push"])).toMatch(/applied push-2/);
      expect(await cli(pushed, ["check"])).toContain("ok");
    } finally {
      rmSync(pushed, { recursive: true, force: true });
      await second.close();
    }
  },
  180_000,
);

function project(name: string): string {
  return mkdtempSync(join(tmpdir(), `okm-${name}-`));
}

function source(path: string): string {
  return JSON.stringify(join(root, path));
}

function writeSchema(
  cwd: string,
  declarations: readonly string[],
  tables: string,
  imports = "",
): void {
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { index, schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      imports,
      ...declarations,
      `export const app = schema({ tables: [${tables}] });`,
      "",
    ].join("\n"),
  );
}

function writeConfig(cwd: string, url: string, namespace?: string): void {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(url)},`,
      ...(namespace === undefined ? [] : [`  namespace: ${JSON.stringify(namespace)},`]),
      "});",
      "",
    ].join("\n"),
  );
}

/**
 * Runs `generate`. A destructive step makes it fail after it writes the file;
 * the test then adds the `okm-allow` line a reviewer would.
 */
async function generateAllowing(cwd: string): Promise<void> {
  try {
    await cli(cwd, ["generate"]);
    return;
  } catch (error) {
    if (OkmError.from(error).code !== "OKM1510") throw error;
  }
  const dir = join(cwd, "migrations");
  const name = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .at(-1);
  if (name === undefined) throw new Error("generate wrote no migration");
  const text = readFileSync(join(dir, name), "utf8");
  writeFileSync(
    join(dir, name),
    text.replace(
      /^(alter table .* drop column .*)$/gm,
      "-- okm-allow OKM1512: the column is unused\n$1",
    ),
  );
}

async function cli(cwd: string, argv: readonly string[]): Promise<string> {
  const result = await invoke(cwd, argv);
  if (result.code !== undefined) {
    throw new OkmError(
      result.code,
      result.message ?? "",
      result.kind === undefined ? undefined : { kind: result.kind },
    );
  }
  return result.stdout;
}

type InvokeResult = {
  readonly stdout: string;
  readonly code?: string;
  readonly message?: string;
  readonly kind?: OkmError["kind"];
};

async function invoke(cwd: string, argv: readonly string[]): Promise<InvokeResult> {
  const script = [
    `import { OkmError } from ${JSON.stringify(join(root, "src/contracts/error.ts"))};`,
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    "const lines = [];",
    "try {",
    `  await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => lines.push(text) });`,
    "  process.stdout.write(JSON.stringify({ stdout: lines.join('') }));",
    "} catch (error) {",
    "  const mapped = OkmError.from(error);",
    "  process.stdout.write(JSON.stringify({ stdout: lines.join(''), code: mapped.code, message: mapped.message, kind: mapped.kind }));",
    "  process.exit(1);",
    "}",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (stdout.startsWith("{")) return JSON.parse(stdout) as InvokeResult;
  throw new Error(stderr.length > 0 ? stderr : `okm exited ${String(code)} with ${stdout}`);
}
