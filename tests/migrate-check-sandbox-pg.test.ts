/**
 * `okm migrate check` must not change the real database.
 *
 * Each case runs as a superuser and as a NOSUPERUSER owner of the schema.
 */

import { expect } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  LIMITED_SCHEMA_OWNER,
  createIsolatedDatabase,
  giveDatabaseToOwner,
  openPostgres,
} from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";

const gate = await loadPostgresGate();
const root = repoRoot();

const REFUSED = [
  "commit; alter table public.t add column zz int",
  "commit; create table public.evil(a int)",
  "end; begin; alter table public.t add column ee int",
  "rollback; alter table public.t add column rr int",
] as const;

const REPLAYED = [
  "alter table public.t add column extra_plain int",
  'create table "public"."t" (id int primary key); alter table "public"."t" add column extra_quoted int',
  "alter table PUBLIC.t add column extra_upper int",
  "alter table public . t add column extra_space int",
  "-- okm-allow OKM1542: replay the body inside the check transaction\ndo $$ begin execute 'alter table public.t add column extra_do int'; end $$",
  "create function public.f() returns int language sql as $$ select 1 $$",
  "comment on schema public is 'leaked'",
] as const;

for (const who of ["superuser", "owner"] as const) {
  postgresTest(
    gate,
    `migrate check as ${who} leaves the real database unchanged`,
    async () => {
      for (const form of [...REFUSED, ...REPLAYED]) {
        const database = await createIsolatedDatabase();
        const admin = openPostgres(database.url);
        const url = who === "owner" ? await giveDatabaseToOwner(database.url) : database.url;
        const sql = who === "owner" ? openPostgres(url) : admin;
        const cwd = mkdtempSync(join(tmpdir(), "okm-check-sandbox-"));
        try {
          await sql.unsafe("create table public.t (id int primary key)");
          const before = await fingerprint(admin);
          const acl = await publicAcl(admin);
          writeProject(cwd, url);
          await cli(cwd, ["generate", "init"]);
          appendFileSync(migration(cwd), `\n\n${form};\n`);
          const refused = REFUSED.some((item) => item === form);
          const quoted = form.includes('"public"');
          if (refused) {
            await expectCheckCode(cwd, "OKM1551");
          } else if (quoted) {
            await expectCheckCode(cwd, "OKM1547");
          } else {
            expect(await cli(cwd, ["migrate", "check"])).toBe("ok 1 migrations\n");
          }
          expect(await fingerprint(admin)).toBe(before);
          expect(await publicAcl(admin)).toBe(acl);
        } finally {
          if (sql !== admin) await sql.end({ timeout: 5 });
          await admin.end({ timeout: 5 });
          rmSync(cwd, { recursive: true, force: true });
          await database.close();
        }
      }
    },
    180_000,
  );

  postgresTest(
    gate,
    `a one-table project passes migrate check as ${who}`,
    async () => {
      const database = await createIsolatedDatabase();
      const url = who === "owner" ? await giveDatabaseToOwner(database.url) : database.url;
      const cwd = mkdtempSync(join(tmpdir(), "okm-check-plain-"));
      try {
        writeProject(cwd, url);
        await cli(cwd, ["generate", "init"]);
        expect(await cli(cwd, ["migrate", "check"])).toBe("ok 1 migrations\n");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        await database.close();
      }
    },
    60_000,
  );
}

postgresTest(
  gate,
  "migrate check passes as okm_owner without CREATEROLE",
  async () => {
    const database = await createIsolatedDatabase();
    const url = await giveDatabaseToOwner(database.url, undefined, LIMITED_SCHEMA_OWNER);
    const cwd = mkdtempSync(join(tmpdir(), "okm-check-limited-"));
    try {
      writeProject(cwd, url);
      await cli(cwd, ["generate", "init"]);
      expect(await cli(cwd, ["migrate", "check"])).toBe("ok 1 migrations\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

type Sql = ReturnType<typeof openPostgres>;

async function fingerprint(sql: Sql): Promise<string> {
  const rows = await sql<{ hash: string }[]>`
    select md5(coalesce(string_agg(line, E'\n' order by line), '')) as hash
    from (
      select 'ns|' || n.nspowner::text || '|' || coalesce(n.nspacl::text, '') as line
      from pg_namespace n
      where n.nspname = 'public'
      union all
      select 'rel|' || c.relname || '|' || c.relkind::text || '|' || c.relrowsecurity::text
        || '|' || c.relforcerowsecurity::text || '|' || coalesce(c.relacl::text, '')
        || '|' || coalesce((
          select string_agg(a.attname || ':' || a.atttypid::text || ':' || a.attnum::text || ':' || a.attnotnull::text, ',' order by a.attnum)
          from pg_attribute a
          where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        ), '')
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'i', 'S', 'f')
      union all
      select 'pol|' || c.relname || '|' || p.polname || '|' || p.polcmd::text
        || '|' || coalesce(pg_get_expr(p.polqual, p.polrelid), '')
        || '|' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
      union all
      select 'fn|' || p.proname || '|' || pg_get_function_identity_arguments(p.oid)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
      union all
      select 'ty|' || t.typname || '|' || t.typtype::text
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public'
      union all
      select 'cmt|' || coalesce(d.description, '')
      from pg_namespace n
      left join pg_description d on d.objoid = n.oid and d.classoid = 'pg_namespace'::regclass
      where n.nspname = 'public'
      union all
      select 'objcmt|' || d.objoid::text || '|' || d.objsubid::text || '|' || d.description
      from pg_description d
      join pg_class c on c.oid = d.objoid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
    ) s
  `;
  return rows[0]?.hash ?? "";
}

async function publicAcl(sql: Sql): Promise<string> {
  const rows = await sql<{ acl: string }[]>`
    select coalesce(nspacl::text, '') as acl from pg_namespace where nspname = 'public'
  `;
  return rows[0]?.acl ?? "";
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

async function expectCheckCode(cwd: string, code: string): Promise<void> {
  let message = "";
  try {
    await cli(cwd, ["migrate", "check"]);
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  expect(message).toContain(code);
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
