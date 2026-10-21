/**
 * OKM1538 heap rewrites and the OKM1552 reprint warning, on Postgres.
 *
 * `pg_class.relfilenode` is the proof that a type change did or did not
 * rewrite. The reprint cases are `okm migrate check`.
 */

import { expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "postgres";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { CHECK_REPLAY_LIMIT } from "../src/tooling/migrate/check.js";

const gate = await loadPostgresGate();
const root = repoRoot();

type RewriteCase = {
  readonly name: string;
  readonly column: string;
  readonly next: string;
  readonly using?: string;
  readonly rewrite: boolean;
  readonly value?: string;
  readonly setup?: string;
  readonly zone?: string;
};

const REWRITE_CASES: readonly RewriteCase[] = [
  {
    name: "varchar widening",
    column: "varchar(10)",
    next: "varchar(20)",
    rewrite: false,
    value: "a",
  },
  { name: "varchar to text", column: "varchar(10)", next: "text", rewrite: false, value: "a" },
  {
    name: "text to unconstrained varchar",
    column: "text",
    next: "varchar",
    rewrite: false,
    value: "a",
  },
  {
    name: "varchar to unconstrained varchar",
    column: "varchar(10)",
    next: "varchar",
    rewrite: false,
    value: "a",
  },
  {
    name: "text to unconstrained bpchar",
    column: "text",
    next: "bpchar",
    rewrite: false,
    value: "a",
  },
  {
    name: "varchar to unconstrained bpchar",
    column: "varchar(10)",
    next: "bpchar",
    rewrite: false,
    value: "a",
  },
  {
    name: "numeric precision increase",
    column: "numeric(6,2)",
    next: "numeric(10,2)",
    rewrite: false,
    value: "1.25",
  },
  {
    name: "numeric to unconstrained",
    column: "numeric(6,2)",
    next: "numeric",
    rewrite: false,
    value: "1.25",
  },
  { name: "integer to oid", column: "integer", next: "oid", rewrite: false, value: "1" },
  { name: "oid to integer", column: "oid", next: "integer", rewrite: false, value: "1" },
  { name: "cidr to inet", column: "cidr", next: "inet", rewrite: false, value: "10.0.0.0/8" },
  { name: "xml to text", column: "xml", next: "text", rewrite: false, value: "<a/>" },
  {
    name: "plain cast using",
    column: "varchar(10)",
    next: "varchar(20)",
    using: "v::varchar(20)",
    rewrite: false,
    value: "a",
  },
  {
    name: "unconstrained domain",
    column: "integer",
    next: "plain_int",
    setup: "create domain plain_int as integer",
    rewrite: false,
    value: "1",
  },
  {
    name: "domain to its base",
    column: "pos_int",
    next: "integer",
    setup: "create domain pos_int as integer check ((value > 0))",
    rewrite: false,
    value: "1",
  },
  { name: "varchar shrink", column: "varchar(20)", next: "varchar(10)", rewrite: true, value: "a" },
  {
    name: "character widening",
    column: "character(3)",
    next: "character(8)",
    rewrite: true,
    value: "a",
  },
  {
    name: "character shrink",
    column: "character(8)",
    next: "character(3)",
    rewrite: true,
    value: "a",
  },
  { name: "integer to bigint", column: "integer", next: "bigint", rewrite: true, value: "1" },
  {
    name: "numeric precision decrease",
    column: "numeric(10,2)",
    next: "numeric(6,2)",
    rewrite: true,
    value: "1.25",
  },
  { name: "text to varchar(n)", column: "text", next: "varchar(10)", rewrite: true, value: "a" },
  { name: "inet to cidr", column: "inet", next: "cidr", rewrite: true, value: "10.0.0.0/8" },
  {
    name: "using expression",
    column: "varchar(10)",
    next: "varchar(20)",
    using: "upper(v)",
    rewrite: true,
    value: "a",
  },
  {
    name: "constrained domain",
    column: "integer",
    next: "bound_int",
    setup: "create domain bound_int as integer check ((value > 0))",
    rewrite: true,
    value: "1",
  },
  {
    name: "timestamp in UTC",
    column: "timestamp",
    next: "timestamptz",
    rewrite: false,
    value: "2020-01-01",
    zone: "UTC",
  },
  {
    name: "timestamp outside UTC",
    column: "timestamp",
    next: "timestamptz",
    rewrite: true,
    value: "2020-01-01",
    zone: "Europe/Berlin",
  },
];

postgresTest(
  gate,
  "OKM1538 classes match pg_class.relfilenode",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      let index = 0;
      for (const item of REWRITE_CASES) {
        index += 1;
        const name = `p${String(index)}`;
        if (item.zone !== undefined) await sql.unsafe(`set time zone '${item.zone}'`);
        if (item.setup !== undefined) await sql.unsafe(item.setup);
        await sql.unsafe(`create table ${name} (v ${item.column})`);
        if (item.value !== undefined) {
          await sql.unsafe(`insert into ${name} (v) values (${quote(item.value)})`);
        }
        const before = await relfilenode(sql, name);
        const using = item.using === undefined ? "" : ` using ${item.using}`;
        await sql.unsafe(`alter table ${name} alter column v type ${item.next}${using}`);
        const after = await relfilenode(sql, name);
        expect(before !== after, item.name).toBe(item.rewrite);
      }
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a reprinted domain check and LANGUAGE sql body are OKM1552",
  async () => {
    const domain = await checkProject([
      `const people = table("people", { n: t.domain("pos", t.integer(), "VALUE > 0") });`,
      "export const app = schema({ tables: [people] });",
    ]);
    // Sealed like okm check / LANGUAGE sql: warning only, not OKM1547 (B-37).
    expect(domain.code).toBe(0);
    expect(domain.text.startsWith("ok 1 migrations\n")).toBe(true);
    expect(domain.text).toContain("warning OKM1552");
    expect(domain.text).toContain("domain pos check reprints differently");

    const matchingDomain = await checkProject([
      `const people = table("people", { n: t.domain("pos", t.integer(), "((VALUE > 0))") });`,
      "export const app = schema({ tables: [people] });",
    ]);
    expect(matchingDomain.code).toBe(0);
    expect(matchingDomain.text).toBe(`ok 1 migrations\n${CHECK_REPLAY_LIMIT}\n`);

    const fn = await checkProject([
      `const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });`,
      `const byId = fn("by_id", { arguments: [{ name: "n", type: "text" }], returns: "text", language: "sql", body: "begin atomic select title from tasks where id = n; end" });`,
      "export const app = schema({ tables: [tasks], functions: [byId] });",
    ]);
    expect(fn.code).toBe(0);
    expect(fn.text.startsWith("ok 1 migrations\n")).toBe(true);
    expect(fn.text).toContain("warning OKM1552");
    expect(fn.text).toContain("function by_id body reprints differently");

    const plain = await checkProject([
      `const answer = fn("answer", { returns: "integer", language: "sql", body: "select 1" });`,
      "export const app = schema({ tables: [], functions: [answer] });",
    ]);
    expect(plain.code).toBe(0);
    expect(plain.text).toBe(`ok 1 migrations\n${CHECK_REPLAY_LIMIT}\n`);

    const allowed = await checkProject(
      [
        `const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });`,
        `const byId = fn("by_id", { arguments: [{ name: "n", type: "text" }], returns: "text", language: "sql", body: "begin atomic select title from tasks where id = n; end" });`,
        "export const app = schema({ tables: [tasks], functions: [byId] });",
      ],
      (sql) => sql.replace(/^(create function )/m, "-- okm-allow OKM1552: reviewed\n$1"),
    );
    expect(allowed.code).toBe(0);
    expect(allowed.text).toStartWith(`ok 1 migrations\n${CHECK_REPLAY_LIMIT}\n`);
    expect(allowed.text).toContain("allow 0001_init step 2 OKM1552 reprint: ");

    const unused = await checkProject(
      [
        `const answer = fn("answer", { returns: "integer", language: "sql", body: "select 1" });`,
        "export const app = schema({ tables: [], functions: [answer] });",
      ],
      (sql) => sql.replace(/^(create function )/m, "-- okm-allow OKM1552: reviewed\n$1"),
    );
    expect(unused.code).not.toBe(0);
    expect(unused.text).toContain("OKM1510");
    expect(unused.text).toContain("override OKM1552 does not match");
  },
  180_000,
);

async function relfilenode(sql: Sql, name: string): Promise<string> {
  const rows = await sql<{ node: string }[]>`
    select relfilenode::text as node from pg_class where relname = ${name}
  `;
  return rows[0]?.node ?? "";
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function checkProject(
  body: readonly string[],
  edit?: (sql: string) => string,
): Promise<{ readonly code: number; readonly text: string }> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-p114-"));
  try {
    writeProject(cwd, database.url, body);
    const generated = await cli(cwd, ["generate", "init"]);
    if (generated.code !== 0) return generated;
    if (edit !== undefined) {
      const file = migrationFile(cwd);
      writeFileSync(file, edit(readFileSync(file, "utf8")));
    }
    return await cli(cwd, ["migrate", "check"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

function writeProject(cwd: string, url: string, body: readonly string[]): void {
  const source = (path: string): string => JSON.stringify(join(root, path));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { fn } from ${source("src/dialects/pg/fn/index.ts")};`,
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      ...body,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${source("src/tooling/migrate/index.ts")};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(url)},`,
      "});",
      "",
    ].join("\n"),
  );
}

function migrationFile(cwd: string): string {
  const name = readdirSync(join(cwd, "migrations")).find((item) => item.endsWith(".sql"));
  if (name === undefined) throw new Error("generate wrote no migration");
  return join(cwd, "migrations", name);
}

async function cli(
  cwd: string,
  argv: readonly string[],
): Promise<{ readonly code: number; readonly text: string }> {
  const script = [
    `import { run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    "const lines = [];",
    `try { await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => lines.push(text) }); }`,
    "catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }",
    "process.stdout.write(lines.join(''));",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", script], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, text: `${stdout}${stderr}` };
}
