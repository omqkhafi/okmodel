/**
 * Expression normalisation writes nothing to the target schema (N-32, N-33).
 *
 * `reprintCheck` and `reprintDomainCheck` build temporary objects with random
 * names. A role with no `CREATE` on the schema can run `okm check` and
 * `okm migrate baseline --dry-run`, nothing remains in the schema, and a
 * schema with enum and domain columns normalises.
 */

import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  LIMITED_SCHEMA_OWNER,
  createIsolatedDatabase,
  openPostgres,
  ownerUrl,
  ensureLimitedSchemaOwner,
} from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { reprintCheck, reprintDomainCheck } from "../src/dialects/pg/introspect.js";
import { catalogQuery } from "../src/tooling/migrate/drift.js";

const gate = await loadPostgresGate();
const root = repoRoot();
const CLI_TIMEOUT_MS = 60_000;

type Sql = ReturnType<typeof openPostgres>;

postgresTest(
  gate,
  "reprintCheck and reprintDomainCheck run without CREATE on the schema and leave nothing in it",
  async () => {
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    await ensureLimitedSchemaOwner();
    const reader = await readerUrl(admin, database.url);
    const sql = openPostgres(reader);
    try {
      const create = await sql<{ ok: boolean }[]>`
        select has_schema_privilege(current_user, 'public', 'CREATE') as ok
      `;
      expect(create[0]?.ok).toBe(false);
      const before = await schemaObjects(admin);
      const runner = catalogQuery(sql);
      expect(await reprintCheck(runner, "((id > 0))")).toBe(await reprintCheck(runner, "id > 0"));
      expect(await reprintDomainCheck(runner, "integer", "VALUE > 0")).toContain("VALUE");
      expect(await schemaObjects(admin)).toEqual(before);
      expect(await scratchObjects(sql)).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
      await admin.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a failed expression leaves no scratch object behind",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const runner = catalogQuery(sql);
      expect(await failed(reprintCheck(runner, "no_such_column > 0"))).toBe(true);
      expect(await failed(reprintDomainCheck(runner, "integer", "VALUE >"))).toBe(true);
      expect(await scratchObjects(sql)).toEqual([]);
      expect(await schemaObjects(sql)).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "enum and domain columns normalise from the catalog, not from the schema (N-33)",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const runner = catalogQuery(sql);
      const types = [
        { name: "color", labels: ["red", "blue"] },
        { name: "shade", base: "color" },
        { name: "pos", base: "integer" },
      ];
      const reprinted = await reprintCheck(
        runner,
        "(color IN ('red', 'blue') AND n > 0 AND tint IS NOT NULL)",
        [
          { name: "color", dataType: "color" },
          { name: "n", dataType: "pos" },
          { name: "tint", dataType: "shade" },
        ],
        types,
      );
      expect(reprinted).toContain("'red'::color");
      expect(reprinted).toContain("(n)::integer > 0");
      expect(await reprintDomainCheck(runner, "color", "VALUE <> 'red'", types)).toContain("red");
      expect(await scratchObjects(sql)).toEqual([]);
      expect(await schemaObjects(sql)).toEqual([]);

      await sql.unsafe("create type color as enum ('red')");
      const widened = await reprintCheck(
        runner,
        "(color = 'blue')",
        [{ name: "color", dataType: "color" }],
        types,
      );
      expect(widened).toContain("'blue'::color");
      expect(await schemaObjects(sql)).toEqual(["type color"]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "okm check works as a role without CREATE, and a pending enum column with a check normalises",
  async () => {
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    await ensureLimitedSchemaOwner();
    const cwd = mkdtempSync(join(tmpdir(), "okm-scratch-"));
    try {
      writeConfig(cwd, database.url);
      writeSchema(cwd, ENUM_AND_DOMAIN);
      await cli(cwd, ["generate", "init"]);
      await cli(cwd, ["migrate", "apply"]);
      const reader = await readerUrl(admin, database.url);
      writeConfig(cwd, reader);
      const before = await schemaObjects(admin);

      const clean = await cli(cwd, ["check"]);
      expect(clean.trimEnd().endsWith("ok")).toBe(true);
      expect(await schemaObjects(admin)).toEqual(before);
      expect(await scratchObjects(admin)).toEqual([]);

      writeSchema(cwd, PENDING_ENUM);
      const pending = await failure(cwd, ["check"]);
      expect(pending).toContain("OKM1531");
      expect(pending).not.toContain("does not exist");
      expect(await schemaObjects(admin)).toEqual(before);
      expect(await scratchObjects(admin)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await admin.end({ timeout: 5 });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "okm migrate baseline --dry-run works as a role without CREATE and leaves nothing behind",
  async () => {
    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    await ensureLimitedSchemaOwner();
    const cwd = mkdtempSync(join(tmpdir(), "okm-scratch-dry-"));
    try {
      writeConfig(cwd, database.url);
      writeSchema(cwd, CHECKED_TABLE);
      await cli(cwd, ["generate", "init"]);
      await admin.unsafe(
        "create table items (id integer primary key, status text not null constraint items_listed_check check (status in ('a', 'b')))",
      );
      const reader = await readerUrl(admin, database.url);
      writeConfig(cwd, reader);
      const before = await schemaObjects(admin);
      const dry = await cli(cwd, ["migrate", "baseline", "--dry-run"]);
      expect(dry).toContain("would baseline");
      expect(await schemaObjects(admin)).toEqual(before);
      expect(await scratchObjects(admin)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await admin.end({ timeout: 5 });
      await database.close();
    }
  },
  90_000,
);

const ENUM_AND_DOMAIN = [
  "export const app = schema({",
  "  tables: [",
  '    table("tickets", {',
  "      id: t.integer().primaryKey(),",
  '      status: t.enum("ticket_status", ["open", "closed"]),',
  '      weight: t.domain("weight", t.integer(), "VALUE > 0"),',
  "    }, {",
  "      checks: {",
  "        open_light: (c) => sql`${c.status} <> 'open' or ${c.weight} < 10`,",
  "      },",
  "    }),",
  "  ],",
  "});",
].join("\n");

const PENDING_ENUM = [
  "export const app = schema({",
  "  tables: [",
  '    table("tickets", {',
  "      id: t.integer().primaryKey(),",
  '      status: t.enum("ticket_status", ["open", "closed"]),',
  '      weight: t.domain("weight", t.integer(), "VALUE > 0"),',
  '      priority: t.enum("ticket_priority", ["low", "high"]).default("low"),',
  "    }, {",
  "      checks: {",
  "        open_light: (c) => sql`${c.status} <> 'open' or ${c.weight} < 10`,",
  "        high_open: (c) => sql`${c.priority} <> 'high' or ${c.status} = 'open'`,",
  "      },",
  "    }),",
  "  ],",
  "});",
].join("\n");

const CHECKED_TABLE = [
  "export const app = schema({",
  "  tables: [",
  '    table("items", { id: t.integer().primaryKey(), status: t.text() }, {',
  "      checks: { listed: (c) => sql`${c.status} in ('a', 'b')` },",
  "    }),",
  "  ],",
  "});",
].join("\n");

/** A login role that can read the schema but has no `CREATE` on `public`. */
async function readerUrl(admin: Sql, databaseUrl: string): Promise<string> {
  await admin.unsafe(`revoke create on schema public from public`);
  await admin.unsafe(`revoke all on schema public from ${LIMITED_SCHEMA_OWNER}`);
  await admin.unsafe(`grant usage on schema public to ${LIMITED_SCHEMA_OWNER}`);
  await admin.unsafe(`grant select on all tables in schema public to ${LIMITED_SCHEMA_OWNER}`);
  return ownerUrl(databaseUrl, LIMITED_SCHEMA_OWNER);
}

/** Relations, types, and constraints in `public`, by name. */
async function schemaObjects(sql: Sql): Promise<readonly string[]> {
  const rows = await sql<{ line: string }[]>`
    select line from (
      select 'rel ' || c.relname as line
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname not like 'okm\\_%'
      union all
      select 'type ' || t.typname
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typtype in ('e', 'd')
      union all
      select 'con ' || k.conname
      from pg_constraint k join pg_namespace n on n.oid = k.connamespace
      where n.nspname = 'public'
    ) s
    order by line
  `;
  return rows.map((row) => row.line);
}

/** Any `okm_expr*` object in any schema, temporary ones included. */
async function scratchObjects(sql: Sql): Promise<readonly string[]> {
  const rows = await sql<{ line: string }[]>`
    select line from (
      select 'rel ' || c.relname as line from pg_class c where c.relname like 'okm\\_expr%'
      union all
      select 'type ' || t.typname from pg_type t where t.typname like 'okm\\_expr%'
      union all
      select 'con ' || k.conname from pg_constraint k where k.conname like 'okm\\_expr%'
    ) s
    order by line
  `;
  return rows.map((row) => row.line);
}

async function failed(pending: Promise<unknown>): Promise<boolean> {
  return pending.then(
    () => false,
    () => true,
  );
}

function writeSchema(cwd: string, body: string): void {
  const source = (path: string): string => JSON.stringify(join(root, path));
  writeFileSync(
    join(cwd, "schema.ts"),
    [`import { schema, sql, t, table } from ${source("src/dialects/pg/index.ts")};`, body, ""].join(
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

async function spawnCli(
  cwd: string,
  argv: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const script = [
    `import { OkmError } from ${JSON.stringify(join(root, "src/contracts/error.ts"))};`,
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    "const lines = [];",
    "try {",
    `  await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => lines.push(text) });`,
    "  process.stdout.write(lines.join(''));",
    "} catch (error) {",
    "  process.stdout.write(lines.join(''));",
    "  process.stderr.write(error instanceof OkmError ? `error ${error.code}: ${error.message}\\n${error.fix.summary}\\n` : String(error));",
    "  process.exitCode = 1;",
    "}",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), CLI_TIMEOUT_MS);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

async function cli(cwd: string, argv: readonly string[]): Promise<string> {
  const result = await spawnCli(cwd, argv);
  if (result.code !== 0) throw new Error(result.stderr.length > 0 ? result.stderr : result.stdout);
  return result.stdout;
}

async function failure(cwd: string, argv: readonly string[]): Promise<string> {
  const result = await spawnCli(cwd, argv);
  expect(result.code).not.toBe(0);
  return `${result.stdout}${result.stderr}`;
}
