/**
 * Tenant-first indexes on Postgres (Q3, PG15–18).
 *
 * A fresh schema applies, checks, and generates nothing the second time.
 * A unique index is per tenant. A table that already has a global index is
 * swapped with a concurrent build, then a concurrent drop.
 */

import { expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const root = repoRoot();

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8e";

postgresTest(
  gate,
  "generate, check, and apply prefix the tenant key, and a unique is per tenant",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-tenant-index-"));
    const sql = openPostgres(database.url);
    try {
      writeFileSync(join(cwd, "schema.ts"), freshSchema());
      writeConfig(cwd, database.url);
      expect(await okm(cwd, ["generate", "init"])).toContain(".sql");
      const created = migrationSql(cwd);
      expect(created).toContain('("tenant_id", "title")');
      expect(created).toContain('("tenant_id", "email")');
      expect(created).toContain("create unique index");
      expect(await okm(cwd, ["migrate", "check"])).toMatch(/^ok \d+ migrations/);
      expect(await okm(cwd, ["migrate", "apply"])).toContain("applied");
      expect(await okm(cwd, ["migrate", "check"])).toMatch(/^ok \d+ migrations/);
      expect(await okm(cwd, ["generate"])).toBe("no changes\n");

      const defs = await sql<{ def: string }[]>`
        select pg_get_indexdef(i.indexrelid) as def
        from pg_index i
        join pg_class c on c.oid = i.indrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'notes'
      `;
      const text = defs.map((row) => row.def).join("\n");
      expect(text).toContain("(tenant_id, title)");
      expect(text).toContain("(tenant_id, email)");

      await sql.unsafe(
        `insert into notes (tenant_id, title, email) values ('${TENANT_A}', 'a', 'shared@example.com'), ('${TENANT_B}', 'b', 'shared@example.com')`,
      );
      // postgres.js queries are thenables. `expect().rejects` retries them and spins.
      let duplicate: unknown;
      try {
        await sql.unsafe(
          `insert into notes (tenant_id, title, email) values ('${TENANT_A}', 'c', 'shared@example.com')`,
        );
      } catch (error) {
        duplicate = error;
      }
      expect(duplicate).toBeInstanceOf(Error);
      expect(duplicate instanceof Error ? duplicate.message : "").toMatch(/unique|duplicate/i);
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
  "an existing tenant index is replaced concurrently, then check is clean",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = mkdtempSync(join(tmpdir(), "okm-tenant-index-replace-"));
    const sql = openPostgres(database.url);
    try {
      writeFileSync(join(cwd, "schema.ts"), legacySchema());
      writeConfig(cwd, database.url);
      expect(await okm(cwd, ["generate", "init"])).toContain(".sql");
      expect(await okm(cwd, ["migrate", "check"])).toMatch(/^ok \d+ migrations/);
      expect(await okm(cwd, ["migrate", "apply"])).toContain("applied");
      await sql.unsafe(
        `insert into notes (tenant_id, title) values ('${TENANT_A}', 'kept'), ('${TENANT_B}', 'kept')`,
      );

      writeFileSync(join(cwd, "schema.ts"), freshTitleSchema());
      expect(await okm(cwd, ["generate", "prefix"])).toContain("prefix");
      const replace = latestMigration(cwd);
      const createAt = replace.search(/create index concurrently/i);
      const dropAt = replace.search(/drop index concurrently/i);
      expect(createAt).toBeGreaterThanOrEqual(0);
      expect(dropAt).toBeGreaterThan(createAt);
      expect(/\bcreate index\b(?! concurrently)/i.test(replace)).toBe(false);
      expect(/\bdrop index\b(?! concurrently)/i.test(replace)).toBe(false);
      expect(replace).toContain('("tenant_id", "title")');
      expect(await okm(cwd, ["migrate", "check"])).toMatch(/^ok \d+ migrations/);
      expect(await okm(cwd, ["migrate", "apply"])).toContain("applied");
      expect(await okm(cwd, ["migrate", "check"])).toMatch(/^ok \d+ migrations/);
      expect(await okm(cwd, ["generate"])).toBe("no changes\n");
      const titles = await sql<{ title: string }[]>`select title from notes order by tenant_id`;
      expect(titles.map((row) => row.title)).toEqual(["kept", "kept"]);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

function freshSchema(): string {
  return [
    `import { index, schema, table, t } from ${source("src/dialects/pg/index.ts")};`,
    `import { columnTenancy } from ${source("src/runtime/tenancy/index.ts")};`,
    "const notes = table(",
    '  "notes",',
    "  { id: t.identity(), title: t.text(), email: t.text() },",
    "  { indexes: (columns) => [index(columns.title), index(columns.email).unique()] },",
    ");",
    "export const app = schema({",
    '  casing: "snake",',
    '  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),',
    "  tables: [notes],",
    "});",
    "",
  ].join("\n");
}

function legacySchema(): string {
  return [
    `import { index, schema, table, t } from ${source("src/dialects/pg/index.ts")};`,
    `import { columnTenancy } from ${source("src/runtime/tenancy/index.ts")};`,
    "const notes = table(",
    '  "notes",',
    "  { id: t.identity(), title: t.text() },",
    '  { indexes: (columns) => [index(columns.title).global("legacy title")] },',
    ");",
    "export const app = schema({",
    '  casing: "snake",',
    '  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),',
    "  tables: [notes],",
    "});",
    "",
  ].join("\n");
}

function freshTitleSchema(): string {
  return [
    `import { index, schema, table, t } from ${source("src/dialects/pg/index.ts")};`,
    `import { columnTenancy } from ${source("src/runtime/tenancy/index.ts")};`,
    "const notes = table(",
    '  "notes",',
    "  { id: t.identity(), title: t.text() },",
    "  { indexes: (columns) => [index(columns.title)] },",
    ");",
    "export const app = schema({",
    '  casing: "snake",',
    '  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),',
    "  tables: [notes],",
    "});",
    "",
  ].join("\n");
}

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

function migrationSql(cwd: string): string {
  return readFileSync(join(cwd, "migrations", onlyMigration(cwd)), "utf8");
}

function latestMigration(cwd: string): string {
  const names = readdirSync(join(cwd, "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const name = names.at(-1);
  if (name === undefined) throw new Error("no migration");
  return readFileSync(join(cwd, "migrations", name), "utf8");
}

function onlyMigration(cwd: string): string {
  const names = readdirSync(join(cwd, "migrations")).filter((name) => name.endsWith(".sql"));
  const name = names[0];
  if (name === undefined || names.length !== 1) throw new Error(`migrations: ${names.join(", ")}`);
  return name;
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
