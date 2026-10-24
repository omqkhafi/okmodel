/**
 * Postgres coverage for casing follow-ups: the OKM1530 guard, identity
 * sequences, and routines whose names or bodies mention a renamed column.
 */

import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  "generate names casing as the cause of OKM1530",
  async () => {
    const before = [
      'const notes = table("userNotes", { id: t.identity(), publishedAt: t.timestamptz().nullable() });',
    ];
    const after = [
      'const notes = table("userNotes", { id: t.identity(), publishedAt: t.timestamptz().nullable() });',
    ];
    const database = await createIsolatedDatabase();
    const dir = project("casing-guard");
    try {
      writeConfig(dir, database.url);
      writeSchema(dir, before, "notes");
      await cli(dir, ["generate", "init"]);
      await cli(dir, ["migrate", "apply"]);
      writeSchema(dir, after, "notes", "snake");
      const error = await rejected(dir, ["generate"]);
      expect(error.code).toBe("OKM1530");
      expect(error.message).toContain("caused by casing");
      expect(error.message).toContain(".sqlName(");
      expect(error.message).toContain(".renamedFrom(");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
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
  casing?: "snake" | "camel",
): void {
  const options =
    casing === undefined
      ? `tables: [${tables}]`
      : `tables: [${tables}], casing: ${JSON.stringify(casing)}`;
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      ...declarations,
      `export const app = schema({ ${options} });`,
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

async function rejected(cwd: string, argv: readonly string[]): Promise<OkmError> {
  const result = await invoke(cwd, argv);
  if (result.code === undefined) throw new Error(`${argv.join(" ")} should have failed`);
  return new OkmError(
    result.code,
    result.message ?? "",
    result.kind === undefined ? undefined : { kind: result.kind },
  );
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
