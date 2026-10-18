/**
 * Postgres coverage for migrate push, external hash re-stamp, check with
 * triggers, and domain-check drift (B-29, B-21, B-24, B-37, B-45).
 */

import { expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  "okm push applies three times and A→B→A, then connect succeeds",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = project("push-repeat");
    try {
      writeSchema(cwd, ["id: t.integer().primaryKey()", "title: t.text()"]);
      writeConfig(cwd, database.url);
      const first = await cli(cwd, ["push"]);
      expect(first).toMatch(/applied push-1/);
      writeSchema(cwd, [
        "id: t.integer().primaryKey()",
        "title: t.text()",
        "note: t.text().nullable()",
      ]);
      const second = await cli(cwd, ["push"]);
      expect(second).toMatch(/applied push-2/);
      writeSchema(cwd, [
        "id: t.integer().primaryKey()",
        "title: t.text()",
        "note: t.text().nullable()",
        "flag: t.boolean().nullable()",
      ]);
      const third = await cli(cwd, ["push"]);
      expect(third).toMatch(/applied push-3/);
      expect(await columns(database.url, "public", "tasks")).toEqual([
        "id",
        "title",
        "note",
        "flag",
      ]);
      expect(await cli(cwd, ["check"])).toContain("ok");
      await connectOk(cwd, database.url);

      writeSchema(cwd, ["id: t.integer().primaryKey()", "title: t.text()"]);
      expect(await cli(cwd, ["push"])).toMatch(/applied push-4/);
      writeSchema(cwd, [
        "id: t.integer().primaryKey()",
        "title: t.text()",
        "note: t.text().nullable()",
      ]);
      expect(await cli(cwd, ["push"])).toMatch(/applied push-5/);
      writeSchema(cwd, ["id: t.integer().primaryKey()", "title: t.text()"]);
      expect(await cli(cwd, ["push"])).toMatch(/applied push-6/);
      await connectOk(cwd, database.url);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "a dependent re-stamps after an external column is added, and a stale snapshot is OKM1841",
  async () => {
    const database = await createIsolatedDatabase();
    const identity = project("identity-push");
    const billing = project("billing-push");
    try {
      writeIdentity(identity, false);
      writeConfig(identity, database.url, { namespace: "identity" });
      await cli(identity, ["push"]);
      await cli(identity, ["catalog", "export", "--out", "identity.okm.json"]);

      writeBilling(billing, identity);
      writeConfig(billing, database.url, {
        namespace: "billing",
        external: [join(identity, "identity.okm.json")],
      });
      await cli(billing, ["generate", "init"]);
      await cli(billing, ["migrate", "apply"]);
      await connectOk(billing, database.url);

      writeIdentity(identity, true);
      expect(await cli(identity, ["push"])).toMatch(/applied push-\d+/);
      await cli(identity, ["catalog", "export", "--out", "identity.okm.json"]);
      writeBilling(billing, identity);
      const applied = await cli(billing, ["migrate", "apply"]);
      expect(applied).toMatch(/restamped restamp-\d+/);
      expect(applied).toContain("nothing to apply");
      await connectOk(billing, database.url);

      // Full loop after re-stamp: status, apply, generate, and migrate check agree (B-45).
      const status = await cli(billing, ["migrate", "status"]);
      expect(status).toContain("current");
      expect(status).not.toContain("ahead by expand");
      expect(await cli(billing, ["migrate", "apply"])).toContain("nothing to apply");
      expect(await cli(billing, ["generate"])).toBe("no changes\n");
      expect(await cli(billing, ["migrate", "check"])).toContain("ok");

      const snapshotPath = join(identity, "identity.okm.json");
      const original = readFileSync(snapshotPath, "utf8");
      const edited = JSON.parse(original) as {
        tables: { columns: { type: string }[] }[];
      };
      const column = edited.tables[0]?.columns[1];
      if (column === undefined) throw new Error("snapshot has no email column");
      column.type = "integer";
      writeFileSync(snapshotPath, `${JSON.stringify(edited, null, 2)}\n`);
      const stale = await rejected(billing, ["check"]);
      expect(stale.code).toBe("OKM1841");
      writeFileSync(snapshotPath, original);
    } finally {
      rmSync(identity, { recursive: true, force: true });
      rmSync(billing, { recursive: true, force: true });
      await database.close();
    }
  },
  180_000,
);

postgresTest(
  gate,
  "triggers with when at each timing pass check (B-46)",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = project("check-trigger-when");
    try {
      writeFileSync(
        join(cwd, "schema.ts"),
        [
          `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
          `import { fn, trigger } from ${source("src/dialects/pg/fn/index.ts")};`,
          'const tasks = table("tasks", { id: t.integer().primaryKey(), title: t.text() });',
          'const touch = fn("touch", {',
          '  returns: "trigger",',
          '  language: "plpgsql",',
          '  body: "begin return new; end",',
          "  dependsOn: [tasks],",
          "});",
          // before / after on tables (instead-of needs a view; trigger() is table-only).
          'const beforeInsert = trigger("tasks_before_insert", {',
          "  on: tasks,",
          '  timing: "before",',
          '  events: ["insert"],',
          '  level: "row",',
          "  calls: touch,",
          // WHEN text matches pg_get_triggerdef so check does not plan a reprint.
          '  when: "new.title IS NOT NULL",',
          "});",
          'const beforeUpdate = trigger("tasks_before_update", {',
          "  on: tasks,",
          '  timing: "before",',
          '  events: ["update"],',
          '  level: "row",',
          "  calls: touch,",
          '  when: "old.title IS DISTINCT FROM new.title",',
          "});",
          'const afterUpdate = trigger("tasks_after_update", {',
          "  on: tasks,",
          '  timing: "after",',
          '  events: ["update"],',
          '  level: "row",',
          "  calls: touch,",
          '  when: "old.title IS DISTINCT FROM new.title",',
          "});",
          'const afterDelete = trigger("tasks_after_delete", {',
          "  on: tasks,",
          '  timing: "after",',
          '  events: ["delete"],',
          '  level: "row",',
          "  calls: touch,",
          '  when: "old.title IS NOT NULL",',
          "});",
          "export const app = schema({",
          "  tables: [tasks],",
          "  functions: [touch],",
          "  triggers: [beforeInsert, beforeUpdate, afterUpdate, afterDelete],",
          "});",
          "",
        ].join("\n"),
      );
      writeConfig(cwd, database.url);
      await cli(cwd, ["generate", "init"]);
      await cli(cwd, ["migrate", "apply"]);
      expect(await cli(cwd, ["migrate", "check"])).toContain("ok");
      expect(await cli(cwd, ["check"])).toContain("ok");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "a trigger with defineConfig namespace generates, applies, and checks (B-47)",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = project("trigger-namespace");
    try {
      writeFileSync(
        join(cwd, "schema.ts"),
        [
          `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
          `import { fn, trigger } from ${source("src/dialects/pg/fn/index.ts")};`,
          'const tasks = table("tasks", { id: t.integer().primaryKey(), title: t.text() });',
          'const touch = fn("touch", {',
          '  returns: "trigger",',
          '  language: "plpgsql",',
          '  body: "begin return new; end",',
          "  dependsOn: [tasks],",
          "});",
          'const fired = trigger("tasks_touch", {',
          "  on: tasks,",
          '  timing: "before",',
          '  events: ["update"],',
          '  level: "row",',
          "  calls: touch,",
          '  when: "old.title IS DISTINCT FROM new.title",',
          "});",
          "export const app = schema({",
          "  tables: [tasks],",
          "  functions: [touch],",
          "  triggers: [fired],",
          "});",
          "",
        ].join("\n"),
      );
      writeConfig(cwd, database.url, { namespace: "app" });
      await cli(cwd, ["generate", "init"]);
      await cli(cwd, ["migrate", "apply"]);
      expect(await cli(cwd, ["migrate", "check"])).toContain("ok");
      expect(await cli(cwd, ["check"])).toContain("ok");
      await connectOk(cwd, database.url);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "migrate check accepts timestamps triggers and hand-written triggers",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = project("check-triggers");
    try {
      writeFileSync(
        join(cwd, "schema.ts"),
        [
          `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
          `import { fn, trigger } from ${source("src/dialects/pg/fn/index.ts")};`,
          `import { timestamps } from ${source("src/runtime/traits/index.ts")};`,
          'const tasks = table("tasks", { id: t.integer().primaryKey(), title: t.text() }, { traits: [timestamps({ enforce: "trigger" })] });',
          'const touch = fn("touch", {',
          '  returns: "trigger",',
          '  language: "plpgsql",',
          '  body: "begin return new; end",',
          "  dependsOn: [tasks],",
          "});",
          'const beforeRow = trigger("tasks_before_row", {',
          "  on: tasks,",
          '  timing: "before",',
          '  events: ["insert", "update"],',
          '  level: "row",',
          "  calls: touch,",
          '  updateOf: ["title"],',
          '  when: "true",',
          "});",
          'const afterStatement = trigger("tasks_after_statement", {',
          "  on: tasks,",
          '  timing: "after",',
          '  events: ["delete"],',
          '  level: "statement",',
          "  calls: touch,",
          "});",
          "export const app = schema({",
          "  tables: [tasks],",
          "  functions: [touch],",
          "  triggers: [beforeRow, afterStatement],",
          "});",
          "",
        ].join("\n"),
      );
      writeConfig(cwd, database.url);
      await cli(cwd, ["generate", "init"]);
      await cli(cwd, ["migrate", "apply"]);
      expect(await cli(cwd, ["migrate", "check"])).toContain("ok");
      expect(await cli(cwd, ["migrate", "check", "--provision"])).toContain("ok");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "okm check does not permanent-drift a non-canonical domain check",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = project("domain-check");
    try {
      writeFileSync(
        join(cwd, "schema.ts"),
        [
          `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
          'export const app = schema({ tables: [table("people", { n: t.domain("pos", t.integer(), "VALUE > 0") })] });',
          "",
        ].join("\n"),
      );
      writeConfig(cwd, database.url);
      await cli(cwd, ["push"]);
      expect(await cli(cwd, ["check"])).toContain("ok");
      await connectOk(cwd, database.url);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "migrate loop agrees for a non-canonical domain check (B-37)",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = project("domain-migrate-loop");
    try {
      writeFileSync(
        join(cwd, "schema.ts"),
        [
          `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
          'export const app = schema({ tables: [table("people", { n: t.domain("pos", t.integer(), "VALUE > 0") })] });',
          "",
        ].join("\n"),
      );
      writeConfig(cwd, database.url);
      await cli(cwd, ["generate", "init"]);
      await cli(cwd, ["migrate", "apply"]);
      expect(await cli(cwd, ["check"])).toContain("ok");
      expect(await cli(cwd, ["generate"])).toBe("no changes\n");
      expect(await cli(cwd, ["migrate", "apply"])).toContain("nothing to apply");
      const status = await cli(cwd, ["migrate", "status"]);
      expect(status).toContain("current");
      const checked = await cli(cwd, ["migrate", "check"]);
      expect(checked.startsWith("ok 1 migrations\n")).toBe(true);
      expect(checked).not.toContain("history differs");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
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

function writeSchema(cwd: string, columns: readonly string[]): void {
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      `export const app = schema({ tables: [table("tasks", { ${columns.join(", ")} })] });`,
      "",
    ].join("\n"),
  );
}

function writeIdentity(cwd: string, withName: boolean): void {
  const columns = withName
    ? "id: t.uuid().primaryKey(), email: t.text(), name: t.text().nullable()"
    : "id: t.uuid().primaryKey(), email: t.text()";
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      `export const users = table("users", { ${columns} });`,
      "export const app = schema({ tables: [users] });",
      "",
    ].join("\n"),
  );
}

function writeBilling(cwd: string, identity: string): void {
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { external, schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      `import { users } from ${JSON.stringify(join(identity, "schema.ts"))};`,
      'const invoices = table("invoices", {',
      "  id: t.uuid().primaryKey(),",
      '  userId: t.uuid().references("users"),',
      "});",
      "export const app = schema({ tables: [external(users), invoices] });",
      "",
    ].join("\n"),
  );
}

function writeConfig(
  cwd: string,
  url: string,
  options?: { readonly namespace?: string; readonly external?: readonly string[] },
): void {
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  const namespace =
    options?.namespace === undefined ? "" : `  namespace: ${JSON.stringify(options.namespace)},\n`;
  const external =
    options?.external === undefined ? "" : `  external: ${JSON.stringify(options.external)},\n`;
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(url)},`,
      namespace.trimEnd(),
      external.trimEnd(),
      "});",
      "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}

async function columns(url: string, namespace: string, table: string): Promise<readonly string[]> {
  const sql = openPostgres(url);
  try {
    const rows = await sql<{ name: string }[]>`
      select a.attname as name
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${namespace} and c.relname = ${table}
        and a.attnum > 0 and not a.attisdropped
      order by a.attnum
    `;
    return rows.map((row) => row.name);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function connectOk(cwd: string, url: string): Promise<void> {
  const script = [
    `import { pathToFileURL } from "node:url";`,
    `import { join } from "node:path";`,
    `import { connect } from ${JSON.stringify(join(root, "src/runtime/pg/postgresjs.ts"))};`,
    `const schemaMod = await import(pathToFileURL(join(${JSON.stringify(cwd)}, "schema.ts")).href);`,
    `const db = connect(${JSON.stringify(url)}, { schema: schemaMod.app, requireMeta: true });`,
    "try { await db.close(); } catch (error) { await db.close().catch(() => undefined); throw error; }",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr.length > 0 ? stderr : `connect exited ${String(code)}`);
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
