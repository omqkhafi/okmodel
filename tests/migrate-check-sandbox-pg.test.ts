/**
 * `okm migrate check` must not change the real schema.
 *
 * A hand-written statement that names `public` used to run there before
 * OKM1550 was reported. The catalog hash of `public` stays the same.
 */

import { expect } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const root = repoRoot();

const FORMS = [
  "alter table public.t add column extra_plain int",
  'alter table "public"."t" add column extra_quoted int',
  "alter table PUBLIC.t add column extra_upper int",
  "alter table public . t add column extra_space int",
  "do $$ begin execute 'alter table public.t add column extra_do int'; end $$",
] as const;

postgresTest(
  gate,
  "migrate check leaves public byte identical for every public qualifier",
  async () => {
    for (const form of FORMS) {
      const database = await createIsolatedDatabase();
      const sql = openPostgres(database.url);
      const cwd = mkdtempSync(join(tmpdir(), "okm-check-sandbox-"));
      try {
        await sql.unsafe("create table public.t (id int primary key)");
        const before = await fingerprint(sql);
        writeProject(cwd, database.url);
        await cli(cwd, ["generate", "init"]);
        appendFileSync(migration(cwd), `\n\n${form};\n`);
        let failed = false;
        try {
          await cli(cwd, ["migrate", "check"]);
        } catch {
          failed = true;
        }
        expect(failed).toBe(true);
        expect(await fingerprint(sql)).toBe(before);
        const columns = await sql<{ attname: string }[]>`
          select a.attname
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 't' and a.attnum > 0 and not a.attisdropped
          order by a.attnum
        `;
        expect(columns.map((row) => row.attname)).toEqual(["id"]);
      } finally {
        await sql.end({ timeout: 5 });
        rmSync(cwd, { recursive: true, force: true });
        await database.close();
      }
    }
  },
  180_000,
);

type Sql = ReturnType<typeof openPostgres>;

async function fingerprint(sql: Sql): Promise<string> {
  const rows = await sql<{ hash: string }[]>`
    select md5(coalesce(string_agg(line, E'\n' order by line), '')) as hash
    from (
      select 'ns|' || n.nspowner::text as line
      from pg_namespace n
      where n.nspname = 'public'
      union all
      select 'rel|' || c.relname || '|' || c.relkind::text || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text
        || '|' || coalesce((
          select string_agg(a.attname || ':' || a.atttypid::text || ':' || a.attnum::text || ':' || a.attnotnull::text, ',' order by a.attnum)
          from pg_attribute a
          where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        ), '')
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'i', 'S', 'f')
      union all
      select 'pol|' || c.relname || '|' || p.polname || '|' || p.polcmd::text || '|' || coalesce(pg_get_expr(p.polqual, p.polrelid), '')
        || '|' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
    ) s
  `;
  return rows[0]?.hash ?? "";
}

function writeProject(cwd: string, url: string): void {
  const source = (path: string): string => JSON.stringify(join(root, path));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      'export const app = schema({ tables: [table("items", { id: t.integer().primaryKey() })] });',
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

function migration(cwd: string): string {
  const name = readdirSync(join(cwd, "migrations")).find((item) => item.endsWith(".sql"));
  if (name === undefined) throw new Error("generate wrote no migration");
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
