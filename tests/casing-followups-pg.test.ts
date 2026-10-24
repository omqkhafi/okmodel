/**
 * Postgres coverage for casing follow-ups: the OKM1530 guard, identity
 * sequences, and routines whose names or bodies mention a renamed column.
 */

import { expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
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

postgresTest(
  gate,
  "renaming an identity column renames its sequence on apply and push",
  async () => {
    const before = ['const notes = table("notes", { entryId: t.identity(), title: t.text() });'];
    const after = [
      'const notes = table("notes", { noteId: t.identity().renamedFrom("entryId"), title: t.text() });',
    ];
    const settled = ['const notes = table("notes", { noteId: t.identity(), title: t.text() });'];
    const database = await createIsolatedDatabase();
    const migrations = project("column-seq-migrate");
    const pushed = project("column-seq-push");
    try {
      writeConfig(migrations, database.url);
      writeSchema(migrations, before, "notes");
      await cli(migrations, ["generate", "init"]);
      await cli(migrations, ["migrate", "apply"]);
      expect(await identitySequence(database.url, "notes", "entryId")).toBe("notes_entryId_seq");
      writeSchema(migrations, after, "notes");
      await generateAllowing(migrations);
      await cli(migrations, ["migrate", "apply"]);
      expect(await identitySequence(database.url, "notes", "noteId")).toBe("notes_noteId_seq");
      writeSchema(migrations, settled, "notes");
      expect(await cli(migrations, ["check"])).toContain("ok");
      await insertIdentity(database.url, "notes", "title");
    } finally {
      rmSync(migrations, { recursive: true, force: true });
      await database.close();
    }
    const second = await createIsolatedDatabase();
    try {
      writeConfig(pushed, second.url);
      writeSchema(pushed, before, "notes");
      await cli(pushed, ["push"]);
      writeSchema(pushed, after, "notes");
      expect(await cli(pushed, ["push"])).toMatch(/applied push-2/);
      expect(await identitySequence(second.url, "notes", "noteId")).toBe("notes_noteId_seq");
      writeSchema(pushed, settled, "notes");
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

async function identitySequence(url: string, table: string, column: string): Promise<string> {
  const sql = openPostgres(url);
  try {
    const rows = await sql<[{ readonly seq: string | null }]>`
      select pg_get_serial_sequence(${table}, ${column}) as seq
    `;
    const seq = rows[0]?.seq ?? "";
    const dot = seq.lastIndexOf(".");
    return (dot === -1 ? seq : seq.slice(dot + 1)).replaceAll('"', "");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function insertIdentity(url: string, table: string, column: string): Promise<void> {
  const sql = openPostgres(url);
  try {
    await sql.unsafe(`insert into ${table} (${column}) values ('kept')`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * `generate` fails on a column rename. The test adds the allow a reviewer would.
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
      /^(alter table .* rename column .*)$/gm,
      "-- okm-allow OKM1519: the old column name is unused\n$1",
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
