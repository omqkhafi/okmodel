/**
 * Provisioning an empty target from the head snapshot (D198).
 *
 * Postgres 15 and 18 run this file. A non-empty target with no history is
 * OKM1851. `okm migrate check --provision` is OKM1521 when the snapshot and
 * a full replay disagree.
 */

import { expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCatalog } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/error.js";
import { introspectSchema } from "../src/dialects/pg/introspect.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import { CHECK_SCHEMA_PREFIX } from "../src/tooling/migrate/check.js";
import { run } from "../src/tooling/migrate/commands.js";
import { catalogQuery } from "../src/tooling/migrate/drift.js";
import { loadMigrations } from "../src/tooling/migrate/files.js";
import { provision } from "../src/tooling/migrate/provision.js";
import { snapshotDifference } from "../src/tooling/migrate/snapshot.js";

const gate = await loadPostgresGate();
const root = repoRoot();

const roles = `table("roles", {
  code: t.text().primaryKey(),
  label: t.text(),
}, { reference: { key: "code", rows: [
  { code: "admin", label: "Admin" },
  { code: "member", label: "Member" },
] } }), table("items", { id: t.integer().primaryKey(), title: t.text() })`;

const rolesNoted = `table("roles", {
  code: t.text().primaryKey(),
  label: t.text(),
}, { reference: { key: "code", rows: [
  { code: "admin", label: "Admin" },
  { code: "member", label: "Member" },
] } }), table("items", { id: t.integer().primaryKey(), title: t.text(), note: t.text().nullable() })`;

const rolesChanged = `table("roles", {
  code: t.text().primaryKey(),
  label: t.text(),
}, { reference: { key: "code", rows: [
  { code: "admin", label: "Administrator" },
  { code: "editor", label: "Editor" },
] } }), table("items", { id: t.integer().primaryKey(), title: t.text(), note: t.text().nullable() })`;

postgresTest(
  gate,
  "an empty target provisions the head and matches a replayed history",
  async () => {
    await withProject(async ({ cwd, url }) => {
      writeSchema(cwd, roles);
      await cli(cwd, ["generate", "init"]);
      writeSchema(cwd, rolesNoted);
      await cli(cwd, ["generate", "note"]);
      const applied = await capture(["migrate", "apply"], cwd);
      expect(applied).toContain("applied provisioned@0002_note");
      expect(applied).not.toContain("0001_init");
      expect(
        await column(url, "select migration_id from okm_history order by migration_id"),
      ).toEqual(["provisioned@0002_note"]);
      expect(await column(url, "select code || '=' || label from roles order by code")).toEqual([
        "admin=Admin",
        "member=Member",
      ]);
      const replay = await createIsolatedDatabase();
      try {
        await applyTarget({
          url: replay.url,
          target: "replay",
          protected: false,
          migrations: loadMigrations(join(cwd, "migrations")),
        });
        expect(
          snapshotDifference(await introspect(url), await introspect(replay.url)),
        ).toBeUndefined();
      } finally {
        await replay.close();
      }
      writeSchema(cwd, rolesChanged);
      const again = await cli(cwd, ["migrate", "apply"]);
      expect(again).toContain("nothing to apply");
      expect(again).not.toContain("0001_init");
      expect(again).not.toContain("0002_note");
      expect(await column(url, "select code || '=' || label from roles order by code")).toEqual([
        "admin=Admin",
        "editor=Editor",
        "member=Member",
      ]);
      expect(
        await column(url, "select migration_id from okm_history order by migration_id"),
      ).toEqual(["provisioned@0002_note"]);
    });
  },
  90_000,
);

postgresTest(
  gate,
  "provision() installs the head on one configured target",
  async () => {
    await withProject(async ({ cwd, url }) => {
      writeSchema(cwd, roles);
      await cli(cwd, ["generate", "init"]);
      const text = await provision("default", cwd);
      expect(text).toContain("applied provisioned@0001_init");
      expect(await column(url, "select code from roles order by code")).toEqual([
        "admin",
        "member",
      ]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a non-empty target with no history is OKM1851",
  async () => {
    await withProject(async ({ cwd, url }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`);
      await cli(cwd, ["generate", "init"]);
      await seed(url, `create table junk (id integer)`);
      const error = await rejected(["migrate", "apply"], cwd);
      expect(error.code).toBe("OKM1851");
      expect(error.message).toContain("junk");
      expect(error.fix?.summary).toContain("empty");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a protected empty target provisions and a protected occupied target is refused",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`);
      await cli(cwd, ["generate", "init"]);
      writeConfig(cwd, { protected: true });
      const applied = await capture(["migrate", "apply"], cwd);
      expect(applied).toContain("applied provisioned@0001_init");
      const occupied = await createIsolatedDatabase();
      try {
        writeConfig(cwd, { url: occupied.url, protected: true });
        await seed(occupied.url, `create table junk (id integer)`);
        const error = await cliRejected(cwd, ["migrate", "apply"]);
        expect(error.code).toBe("OKM1851");
        expect(error.message).toContain("junk");
      } finally {
        await occupied.close();
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "check --provision passes and a broken snapshot is OKM1521",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey(), title: t.text() })`);
      await cli(cwd, ["generate", "init"]);
      expect(await capture(["migrate", "check", "--provision"], cwd)).toBe("ok 1 migrations\n");
      expect(await scratchSchemas(cwd)).toEqual([]);
      const path = migrationPath(cwd, ".catalog.json");
      const stored = parseCatalog(readFileSync(path, "utf8"));
      const broken = {
        ...stored,
        objects: stored.objects.map((object) => {
          if (object.kind !== "column" || object.identity.name !== "title") return object;
          return { ...object, definition: { ...object.definition, dataType: "integer" } };
        }),
      };
      writeFileSync(path, `${JSON.stringify(broken, null, 2)}\n`);
      const error = await rejected(["migrate", "check", "--provision"], cwd);
      expect(error.code).toBe("OKM1521");
      expect(error.message.toLowerCase()).toContain("title");
      expect(await scratchSchemas(cwd)).toEqual([]);
    });
  },
  90_000,
);

postgresTest(
  gate,
  "check --provision refuses a protected target before it writes",
  async () => {
    await withProject(async ({ cwd }) => {
      writeSchema(cwd, `table("items", { id: t.integer().primaryKey() })`);
      await cli(cwd, ["generate", "init"]);
      writeConfig(cwd, { protected: true });
      const error = await rejected(["migrate", "check", "--provision"], cwd);
      expect(error.code).toBe("OKM1850");
    });
  },
  60_000,
);

async function column(url: string, statement: string): Promise<string[]> {
  const sql = openPostgres(url);
  try {
    const rows = await sql.unsafe(statement);
    return rows.map((row) => String(Object.values(row)[0]));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function seed(url: string, statement: string): Promise<void> {
  const sql = openPostgres(url);
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function introspect(url: string) {
  const sql = openPostgres(url);
  try {
    return await introspectSchema(catalogQuery(sql), "public", "public");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function scratchSchemas(cwd: string): Promise<string[]> {
  const sql = openPostgres(databaseUrl(cwd));
  try {
    const rows = await sql<{ nspname: string }[]>`
      select nspname from pg_namespace where nspname like ${`${CHECK_SCHEMA_PREFIX}%`}
    `;
    return rows.map((row) => row.nspname);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function databaseUrl(cwd: string): string {
  const text = readFileSync(join(cwd, "okmodel.config.ts"), "utf8");
  const match = /postgres:\/\/[^"']+/.exec(text);
  if (match === null) throw new Error("config has no database url");
  return match[0];
}

async function withProject(
  body: (context: { cwd: string; url: string }) => Promise<void>,
): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-provision-"));
  try {
    writeConfig(cwd, { url: database.url });
    await body({ cwd, url: database.url });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

function writeSchema(cwd: string, tables: string): void {
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${pg};`,
      "export const app = schema({",
      `  tables: [${tables}],`,
      "});",
      "",
    ].join("\n"),
  );
}

function writeConfig(
  cwd: string,
  options: { readonly url?: string; readonly protected?: boolean },
): void {
  const url = options.url ?? databaseUrl(cwd);
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  const target =
    options.protected === true
      ? `{ url: ${JSON.stringify(url)}, protected: true }`
      : JSON.stringify(url);
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${target},`,
      "});",
      "",
    ].join("\n"),
  );
}

function migrationPath(cwd: string, suffix: string): string {
  const name = readdirSync(join(cwd, "migrations")).find((file) => file.endsWith(suffix));
  if (name === undefined) throw new Error(`no migration ${suffix}`);
  return join(cwd, "migrations", name);
}

async function cli(cwd: string, argv: readonly string[]): Promise<string> {
  const script = [
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    "const lines = [];",
    `await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => lines.push(text) });`,
    "process.stdout.write(lines.join(''));",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr.length > 0 ? stderr : stdout);
  return stdout;
}

async function capture(argv: readonly string[], cwd: string): Promise<string> {
  const lines: string[] = [];
  await run(argv, { cwd, stdout: (text) => lines.push(text) });
  return lines.join("");
}

async function cliRejected(cwd: string, argv: readonly string[]): Promise<OkmError> {
  const script = [
    `import { OkmError } from ${JSON.stringify(join(root, "src/contracts/error.ts"))};`,
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    "try {",
    `  await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: () => {} });`,
    "} catch (error) {",
    "  if (error instanceof OkmError) {",
    "    process.stderr.write(JSON.stringify({ code: error.code, message: error.message, fix: error.fix }));",
    "  } else {",
    "    process.stderr.write(error instanceof Error ? error.message : String(error));",
    "  }",
    "  process.exit(1);",
    "}",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code === 0) throw new Error(`${argv.join(" ")} should have failed`);
  const parsed: unknown = JSON.parse(stderr);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("code" in parsed) ||
    !("message" in parsed)
  ) {
    throw new Error(stderr);
  }
  const record = parsed as { code: string; message: string; fix?: { summary: string } };
  return new OkmError(
    record.code,
    record.message,
    record.fix === undefined ? {} : { fix: record.fix },
  );
}

async function rejected(argv: readonly string[], cwd: string): Promise<OkmError> {
  try {
    await run(argv, { cwd, stdout: () => {} });
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error(`${argv.join(" ")} should have failed`);
}
