/**
 * Postgres coverage for casing follow-ups: the OKM1530 guard, identity
 * sequences, and routines whose names or bodies mention a renamed column.
 */

import { expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { pgTrgm } from "../src/dialects/pg/ext/pg-trgm.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
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

postgresTest(
  gate,
  "a rename recreates a function and a trigger whose body names the old column",
  async () => {
    const routines = { functions: "length, named, guard", triggers: "fired" };
    const before = [
      'const notes = table("notes", { id: t.identity(), title: t.text() });',
      'const length = fn("title_len", { returns: "integer", language: "plpgsql", body: \'begin return (select length("title") from notes limit 1); end\', dependsOn: [{ table: notes, column: "title" }] });',
      'const named = fn("notes_title_len", { returns: "integer", language: "plpgsql", body: \'begin return (select length("title") from notes limit 1); end\', dependsOn: [{ table: notes, column: "title" }] });',
      'const guard = fn("guard", { returns: "trigger", language: "plpgsql", body: "begin return new; end", dependsOn: [notes] });',
      'const fired = trigger("notes_guard", { on: notes, timing: "before", events: ["update"], level: "row", calls: guard, when: \'OLD."title" is not null\' });',
    ];
    const after = [
      'const notes = table("notes", { id: t.identity(), heading: t.text().renamedFrom("title") });',
      'const length = fn("title_len", { returns: "integer", language: "plpgsql", body: \'begin return (select length("heading") from notes limit 1); end\', dependsOn: [{ table: notes, column: "heading" }] });',
      'const named = fn("notes_heading_len", { returns: "integer", language: "plpgsql", body: \'begin return (select length("heading") from notes limit 1); end\', dependsOn: [{ table: notes, column: "heading" }] });',
      'const guard = fn("guard", { returns: "trigger", language: "plpgsql", body: "begin return new; end", dependsOn: [notes] });',
      'const fired = trigger("notes_guard", { on: notes, timing: "before", events: ["update"], level: "row", calls: guard, when: \'OLD."heading" is not null\' });',
    ];
    const settled = after.map((line) => line.replace('.renamedFrom("title")', ""));
    const database = await createIsolatedDatabase();
    const migrations = project("routine-rename-migrate");
    const pushed = project("routine-rename-push");
    try {
      writeConfig(migrations, database.url);
      writeSchema(migrations, before, "notes", undefined, routines);
      await cli(migrations, ["generate", "init"]);
      await cli(migrations, ["migrate", "apply"]);
      await exec(database.url, "insert into notes (title) values ('kept')");
      expect(await scalar(database.url, "select title_len() as n")).toBe("4");
      writeSchema(migrations, after, "notes", undefined, routines);
      await generateAllowing(migrations);
      await cli(migrations, ["migrate", "apply"]);
      expect(await scalar(database.url, "select title_len() as n")).toBe("4");
      expect(await scalar(database.url, "select notes_heading_len() as n")).toBe("4");
      await exec(database.url, `update notes set "heading" = 'ab'`);
      expect(await scalar(database.url, "select title_len() as n")).toBe("2");
      const triggerDef = await scalar(
        database.url,
        "select pg_get_triggerdef(oid) as def from pg_trigger where tgname = 'notes_guard' and not tgisinternal",
      );
      expect(triggerDef).toContain("heading");
      expect(triggerDef).not.toContain("title");
      writeSchema(migrations, settled, "notes", undefined, routines);
      expect(await cli(migrations, ["check"])).toContain("ok");
      expect(await cli(migrations, ["generate"])).toBe("no changes\n");
    } finally {
      rmSync(migrations, { recursive: true, force: true });
      await database.close();
    }
    const second = await createIsolatedDatabase();
    try {
      writeConfig(pushed, second.url);
      writeSchema(pushed, before, "notes", undefined, routines);
      await cli(pushed, ["push"]);
      await exec(second.url, "insert into notes (title) values ('kept')");
      writeSchema(pushed, after, "notes", undefined, routines);
      expect(await cli(pushed, ["push"])).toMatch(/applied push-2/);
      expect(await scalar(second.url, "select title_len() as n")).toBe("4");
      expect(await scalar(second.url, "select notes_heading_len() as n")).toBe("4");
      writeSchema(pushed, settled, "notes", undefined, routines);
      expect(await cli(pushed, ["check"])).toContain("ok");
    } finally {
      rmSync(pushed, { recursive: true, force: true });
      await second.close();
    }
  },
  180_000,
);

postgresTest(
  gate,
  "OKM1060 covers a unique gin index and a casing other than snake or camel",
  async () => {
    const casing = thrown(() => schema({ casing: "kebab" as "snake", tables: [] }));
    expect(casing.code).toBe("OKM1060");
    expect(casing.message).toContain("snake or camel");
    const trgm = pgTrgm();
    const gin = thrown(() =>
      schema({
        extensions: [trgm],
        tables: [
          table(
            "notes",
            { id: t.integer().primaryKey(), title: t.text() },
            { indexes: (columns) => [trgm.gin(columns.title.name).unique()] },
          ),
        ],
      }),
    );
    expect(gin.code).toBe("OKM1060");
    expect(gin.message).toContain("gin");
    expect(gin.message).toContain("notes_title_idx");
  },
  30_000,
);

postgresTest(
  gate,
  "snake and camel store iOS, IPv6Address, and userId2FA as spelled",
  async () => {
    const declarations = [
      'const notes = table("notes", { id: t.identity(), iOS: t.text(), IPv6Address: t.text(), userId2FA: t.text() });',
    ];
    const database = await createIsolatedDatabase();
    const snake = project("casing-words-snake");
    try {
      writeConfig(snake, database.url);
      writeSchema(snake, declarations, "notes", "snake");
      await cli(snake, ["generate", "init"]);
      await cli(snake, ["migrate", "apply"]);
      expect([...(await columnNames(database.url))].sort()).toEqual(
        ["id", "i_os", "i_pv6_address", "user_id2_fa"].sort(),
      );
    } finally {
      rmSync(snake, { recursive: true, force: true });
      await database.close();
    }
    const second = await createIsolatedDatabase();
    const camel = project("casing-words-camel");
    try {
      writeConfig(camel, second.url);
      writeSchema(camel, declarations, "notes", "camel");
      await cli(camel, ["generate", "init"]);
      await cli(camel, ["migrate", "apply"]);
      expect([...(await columnNames(second.url))].sort()).toEqual(
        ["id", "iOs", "iPv6Address", "userId2Fa"].sort(),
      );
    } finally {
      rmSync(camel, { recursive: true, force: true });
      await second.close();
    }
  },
  120_000,
);

function thrown(fn: () => unknown): OkmError {
  try {
    fn();
  } catch (error) {
    return OkmError.from(error);
  }
  throw new Error("expected a rejection");
}

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
  routines?: { readonly functions: string; readonly triggers: string },
): void {
  const parts = [`tables: [${tables}]`];
  if (casing !== undefined) parts.push(`casing: ${JSON.stringify(casing)}`);
  if (routines !== undefined) {
    parts.push(`functions: [${routines.functions}]`, `triggers: [${routines.triggers}]`);
  }
  const imports = [
    ...(routines === undefined
      ? []
      : [`import { fn, trigger } from ${source("src/dialects/pg/fn/index.ts")};`]),
    `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
  ];
  writeFileSync(
    join(cwd, "schema.ts"),
    [...imports, ...declarations, `export const app = schema({ ${parts.join(", ")} });`, ""].join(
      "\n",
    ),
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

async function columnNames(url: string): Promise<string[]> {
  const sql = openPostgres(url);
  try {
    const rows = await sql<{ attname: string }[]>`
      select attname from pg_attribute
      where attrelid = 'notes'::regclass and attnum > 0 and not attisdropped
      order by attnum
    `;
    return rows.map((row) => row.attname);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function scalar(url: string, statement: string): Promise<string> {
  const sql = openPostgres(url);
  try {
    const rows = await sql.unsafe(statement);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return "";
    const value = Object.values(row)[0];
    return value === null || value === undefined ? "" : String(value);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function exec(url: string, statement: string): Promise<void> {
  const sql = openPostgres(url);
  try {
    await sql.unsafe(statement);
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
    text
      .replace(
        /^(alter table .* rename column .*)$/gm,
        "-- okm-allow OKM1519: the old column name is unused\n$1",
      )
      .replace(
        /^(drop function .*)$/gm,
        "-- okm-allow OKM1515: the old function name is unused\n$1",
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
