/**
 * Reporting and column grants keep column identifier bytes.
 *
 * Default casing used to lowercase `tenantId` inside `GRANT SELECT (...)`.
 * Generate, apply, migrate check, and okm check stay clean.
 */

import { expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  createIsolatedDatabase,
  giveDatabaseToOwner,
  openPostgres,
  SCHEMA_OWNER,
} from "../packages/harness/src/postgres.js";
import { quoteIdent } from "../src/dialects/pg/ddl.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "a camelCase rls project with reporting grants applies and checks clean",
  async () => {
    const mig = roleName("mig");
    const app = roleName("app");
    const report = roleName("report");
    const reader = roleName("reader");
    const database = await createIsolatedDatabase();
    const url = await giveDatabaseToOwner(database.url);
    const sql = openPostgres(database.url);
    const cwd = mkdtempSync(join(tmpdir(), "okm-grant-case-"));
    try {
      await sql.unsafe(
        `create role ${quoteIdent(mig)} nosuperuser nobypassrls nocreatedb createrole`,
      );
      await sql.unsafe(`grant ${quoteIdent(mig)} to ${SCHEMA_OWNER}`);
      await sql.unsafe(`alter schema public owner to ${quoteIdent(mig)}`);
      writeProject(cwd, url, "rls", { mig, app, report, reader });
      const lines = await cycle(cwd);
      const sqlText = readFileSync(migration(cwd), "utf8");
      expect(sqlText).toContain('"tenantId"');
      expect(sqlText).toContain('"Mixed Case"');
      expect(sqlText).toContain('"note_body"');
      expect(sqlText).not.toContain("tenantid");
      expect(sqlText).not.toContain('"mixed case"');
      expect(lines).toContain("applied");
      expect(lines).toContain("ok 1 migrations\n");
      expect(lines.endsWith("ok\n")).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
      await dropRoles([mig, app, report, reader]);
    }
  },
  90_000,
);

postgresTest(
  gate,
  "a path project with permuted table names applies and checks clean",
  async () => {
    const database = await createIsolatedDatabase();
    const url = await giveDatabaseToOwner(database.url);
    const cwd = mkdtempSync(join(tmpdir(), "okm-path-order-"));
    try {
      writeProject(cwd, url, "path");
      const lines = await cycle(cwd);
      expect(lines).toContain("applied");
      expect(lines).toContain("ok 1 migrations\n");
      expect(lines.endsWith("ok\n")).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  90_000,
);

function writeProject(
  cwd: string,
  url: string,
  kind: "rls" | "path",
  roles?: { mig: string; app: string; report: string; reader: string },
): void {
  const source = (path: string): string => JSON.stringify(join(root, path));
  const body =
    kind === "rls"
      ? [
          `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
          `import { rlsTenancy } from ${source("src/runtime/tenancy/index.ts")};`,
          'const rows = table("rows", {',
          "  id: t.integer().primaryKey(),",
          '  label: t.text().sqlName("Mixed Case"),',
          "  note_body: t.text(),",
          "  secret: t.text().hidden(),",
          "});",
          "export const app = schema({",
          '  tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),',
          "  tables: [rows],",
          "});",
        ]
      : [
          `import { one, schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
          `import { columnTenancy, via } from ${source("src/runtime/tenancy/index.ts")};`,
          'const orgs = table("zzz_orgs", { id: t.id({ default: "uuidv4" }), name: t.text() });',
          'const tasks = table("aaa_tasks", {',
          '  id: t.id({ default: "uuidv4" }),',
          "  title: t.text(),",
          '  orgId: t.uuid().references("zzz_orgs"),',
          '}, { tenancy: via("org"), relations: { org: one("zzz_orgs", "orgId") } });',
          "export const app = schema({",
          '  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),',
          "  tables: [tasks, orgs],",
          "});",
        ];
  writeFileSync(join(cwd, "schema.ts"), `${body.join("\n")}\n`);
  const roleLines =
    roles === undefined
      ? []
      : [
          "  roles: {",
          `    migration: ${JSON.stringify(roles.mig)},`,
          `    app: ${JSON.stringify(roles.app)},`,
          `    reporting: ${JSON.stringify(roles.report)},`,
          "    managed: [",
          `      { name: ${JSON.stringify(roles.mig)} },`,
          `      { name: ${JSON.stringify(roles.app)}, login: true },`,
          `      { name: ${JSON.stringify(roles.report)}, login: true },`,
          `      { name: ${JSON.stringify(roles.reader)}, login: true },`,
          "    ],",
          "    columns: [{",
          `      role: ${JSON.stringify(roles.reader)},`,
          '      on: "rows",',
          '      select: ["tenantId", "Mixed Case", "note_body"],',
          '      update: ["tenantId", "note_body"],',
          "    }],",
          "  },",
        ];
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${source("src/tooling/migrate/index.ts")};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(url)},`,
      ...roleLines,
      "});",
      "",
    ].join("\n"),
  );
}

function migration(cwd: string): string {
  const name = readdirSync(join(cwd, "migrations")).find((item) => item.endsWith(".sql"));
  if (name === undefined) throw new Error("generate wrote no migration");
  return join(cwd, "migrations", name);
}

async function cycle(cwd: string): Promise<string> {
  const lines: string[] = [];
  const stdout = (text: string): void => {
    lines.push(text);
  };
  await run(["generate", "init"], { cwd, stdout });
  await run(["migrate", "apply"], { cwd, stdout });
  await run(["migrate", "check"], { cwd, stdout });
  await run(["check"], { cwd, stdout });
  return lines.join("");
}

function roleName(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

async function dropRoles(names: readonly string[]): Promise<void> {
  const admin = openPostgres();
  try {
    for (const name of names) {
      await admin.unsafe(`drop role if exists ${quoteIdent(name)}`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}
