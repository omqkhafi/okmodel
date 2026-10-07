/**
 * Roles, grants, and default privileges on Postgres.
 *
 * The application role is not the owner. Later objects are reachable through
 * default privileges. A missing `CREATEROLE` stops apply before any statement.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
import { catalogHash, parseCatalog } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/error.js";
import { quoteIdent } from "../src/dialects/pg/ddl.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { attachRoles } from "../src/dialects/pg/role/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import { run } from "../src/tooling/migrate/commands.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { app as reference } from "./fixtures/reference-app/schema.js";

const gate = await loadPostgresGate();
const root = repoRoot();

const TASKS = [
  `const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });`,
  "export const app = schema({ tables: [tasks] });",
].join("\n");

const IS_OPEN = [
  `const tasks = table("tasks", { id: t.identity(), status: t.text() });`,
  `const isOpen = fn("is_open", { arguments: [{ name: "status", type: "text" }], returns: "boolean", language: "sql", volatility: "immutable", body: "select status <> 'done'" });`,
  "export const app = schema({ tables: [tasks], functions: [isOpen] });",
].join("\n");

postgresTest(
  gate,
  "default privileges reach later objects and the second plan is empty",
  async () => {
    const mig = roleName("mig");
    const app = roleName("app");
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      await sql.unsafe(
        `create role ${quoteIdent(app)} login password 'secret' nosuperuser nocreatedb nocreaterole`,
      );
      const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });
      const declared = attachRoles(schema({ tables: [tasks] }).catalog, {
        migration: mig,
        app,
        managed: [{ name: mig }],
      });
      const report = await applyTarget({
        url: database.url,
        target: "default",
        protected: false,
        migrationRole: mig,
        migrations: [
          {
            id: "0001_roles",
            catalogHash: "roles",
            steps: planMigration({ before: catalog([]), after: declared, name: "roles" }).steps,
          },
        ],
      });
      expect(report.setRole).toBe(mig);
      const owner = await sql<{ tableowner: string }[]>`
        select tableowner from pg_tables where tablename = 'tasks'
      `;
      expect(owner[0]?.tableowner).toBe(mig);

      const live = await introspectSchema(queryOf(sql), "public", "public", {
        managedRoles: [mig],
      });
      const second = await introspectSchema(queryOf(sql), "public", "public", {
        managedRoles: [mig],
      });
      expect(planMigration({ before: live, after: second, name: "again" }).steps).toEqual([]);
      const privilegeDrift = planMigration({ before: live, after: declared, name: "declared" })
        .steps.map((step) => step.sql)
        .filter((statement) =>
          /role|grant|revoke|default privileges|okm_meta|okm_history/i.test(statement),
        );
      expect(privilegeDrift).toEqual([]);

      await sql.unsafe(`set role ${quoteIdent(mig)}`);
      await sql.unsafe(`create table later (id text primary key, title text)`);
      await sql.unsafe(`create view later_v as select id, title from later`);
      await sql.unsafe(
        `create function later_f() returns text language sql as $$ select 'ok'::text $$`,
      );
      await sql.unsafe(`reset role`);

      await sql.unsafe(`drop table if exists okm_meta, okm_history`);
      const appUrl = urlAs(database.url, app, "secret");
      const clientTasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });
      const db = connect(appUrl, { schema: schema({ tables: [clientTasks] }), max: 1 });
      try {
        await db.connected;
        await db.tasks.insert({ id: "1", title: "a" });
        const found = await db.tasks.find({ limit: 1 });
        expect(found[0]?.title).toBe("a");
      } finally {
        await db.close();
      }
      await sql.unsafe(`set role ${quoteIdent(app)}`);
      const written = await sql<{ title: string }[]>`select title from tasks where id = '1'`;
      expect(written[0]?.title).toBe("a");
      const view = await sql<{ title: string }[]>`select title from later_v`;
      expect(Number(view.length)).toBe(0);
      await sql.unsafe(`insert into later (id, title) values ('2', 'b')`);
      const again = await sql<{ title: string }[]>`select title from later where id = '2'`;
      expect(again[0]?.title).toBe("b");
      const marked = await sql<{ later_f: string }[]>`select later_f() as later_f`;
      expect(marked[0]?.later_f).toBe("ok");
      await sql.unsafe(`reset role`);
      await sql.unsafe(`create table secret (id text)`);
      await sql.unsafe(`set role ${quoteIdent(app)}`);
      let denied = false;
      try {
        await sql.unsafe(`select * from secret`);
      } catch (error) {
        denied = error instanceof Error;
      }
      expect(denied).toBe(true);
      await sql.unsafe(`reset role`);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
      await dropRoles([mig, app]);
    }
  },
  60_000,
);

postgresTest(
  gate,
  "okm doctor reports a missing external role and a missing privilege",
  async () => {
    const mig = roleName("mig");
    const missing = roleName("missing");
    const app = roleName("app");
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      await sql.unsafe(`create role ${quoteIdent(mig)} nologin`);
      const missingDir = project(root, database.url, {
        migration: mig,
        app: missing,
      });
      try {
        let missingRole: unknown;
        try {
          await run(["doctor"], { cwd: missingDir });
        } catch (caught) {
          missingRole = caught;
        }
        expect(missingRole).toBeInstanceOf(Error);
        expect(missingRole instanceof Error ? missingRole.message : "").toMatch(/does not exist/);
      } finally {
        rmSync(missingDir, { recursive: true, force: true });
      }

      await sql.unsafe(`create role ${quoteIdent(app)} nologin`);
      await sql.unsafe(`create table tasks (id text primary key, title text)`);
      const privilegeDir = project(root, database.url, { migration: mig, app });
      try {
        let caught: unknown;
        try {
          await run(["doctor"], { cwd: privilegeDir });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(OkmError);
        expect((caught as OkmError).code).toBe("OKM1825");
      } finally {
        rmSync(privilegeDir, { recursive: true, force: true });
      }
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
      await dropRoles([mig, app, missing]);
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a role without CREATEROLE blocks apply before any statement",
  async () => {
    const limited = roleName("limited");
    const mig = roleName("mig");
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const databaseName = new URL(database.url).pathname.slice(1);
      await sql.unsafe(
        `create role ${quoteIdent(limited)} login password 'secret' nosuperuser nocreatedb nocreaterole`,
      );
      await sql.unsafe(
        `grant connect on database ${quoteIdent(databaseName)} to ${quoteIdent(limited)}`,
      );
      const declared = attachRoles(
        schema({ tables: [table("tasks", { id: t.text().primaryKey() })] }).catalog,
        {
          migration: mig,
          app: limited,
          managed: [{ name: mig }],
        },
      );
      let caught: unknown;
      try {
        await applyTarget({
          url: urlAs(database.url, limited, "secret"),
          target: "default",
          protected: false,
          migrationRole: mig,
          migrations: [
            {
              id: "0001_roles",
              catalogHash: "roles",
              steps: planMigration({ before: catalog([]), after: declared, name: "roles" }).steps,
            },
          ],
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OkmError);
      expect((caught as OkmError).message).toContain("CREATEROLE");
      const roles = await sql<
        { rolname: string }[]
      >`select rolname from pg_roles where rolname = ${mig}`;
      expect(roles.length).toBe(0);
      const tables = await sql<{ tablename: string }[]>`
        select tablename from pg_tables where tablename in ('tasks', 'okm_meta')
      `;
      expect(tables.length).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
      await dropRoles([limited, mig]);
    }
  },
  60_000,
);

postgresTest(
  gate,
  "okm doctor reports a missing EXECUTE on a function with a named argument",
  async () => {
    const app = roleName("app");
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const cwd = mkdtempSync(join(tmpdir(), "okm-roles-"));
    try {
      await sql.unsafe(`create role ${quoteIdent(app)} nologin`);
      await sql.unsafe(
        `create function is_open(status text) returns boolean language sql immutable as $$ select status <> 'done' $$`,
      );
      await sql.unsafe(`revoke execute on function is_open(text) from public`);
      writeProject(
        cwd,
        database.url,
        { app },
        [
          `const isOpen = fn("is_open", { arguments: [{ name: "status", type: "text" }], returns: "boolean", language: "sql", volatility: "immutable", body: "select status <> 'done'" });`,
          "export const app = schema({ tables: [], functions: [isOpen] });",
        ].join("\n"),
      );
      const error = await rejected(["doctor"], cwd);
      expect(error.code).toBe("OKM1825");
      expect(error.message).toContain("EXECUTE on public.is_open");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await sql.end({ timeout: 5 });
      await database.close();
      await dropRoles([app]);
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a function grant with a named argument has no drift",
  async () => {
    await withRolesProject(IS_OPEN, async ({ cwd }) => {
      await output(["generate", "init"], cwd);
      await output(["migrate", "apply"], cwd);
      expect(await output(["check"], cwd)).toBe("ok\n");
      expect(await output(["migrate", "check"], cwd)).toBe("ok 1 migrations\n");
      expect(await output(["migrate", "check", "--provision"], cwd)).toBe("ok 1 migrations\n");
    });
  },
  90_000,
);

postgresTest(
  gate,
  "migrate check with roles leaves the target's privileges alone",
  async () => {
    await withRolesProject(TASKS, async ({ cwd, sql }) => {
      await output(["generate", "init"], cwd);
      const before = await targetAcl(sql);
      expect(await output(["migrate", "check"], cwd)).toBe("ok 1 migrations\n");
      expect(await targetAcl(sql)).toBe(before);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "migrate check --provision with roles leaves the target's own objects alone",
  async () => {
    await withRolesProject(IS_OPEN, async ({ cwd, sql }) => {
      await output(["generate", "init"], cwd);
      await sql.unsafe(
        `create table tasks (id bigint generated by default as identity primary key, status text not null)`,
      );
      await sql.unsafe(
        `create function is_open(status text) returns boolean language sql immutable as $$ select status <> 'done' $$`,
      );
      const before = await targetAcl(sql);
      expect(await output(["migrate", "check", "--provision"], cwd)).toBe("ok 1 migrations\n");
      expect(await targetAcl(sql)).toBe(before);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "connect needs no catalogDir after an apply with roles",
  async () => {
    await withRolesProject(TASKS, async ({ cwd, url }) => {
      await output(["generate", "init"], cwd);
      await output(["migrate", "apply"], cwd);
      await expectConnects(url);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "apply moves a pre-D208 roles hash to the startup hash, and leaves any other hash",
  async () => {
    await withRolesProject(
      TASKS,
      async ({ cwd, url, sql }) => {
        await output(["generate", "init"], cwd);
        await output(["migrate", "apply"], cwd);
        const stored = readFileSync(join(cwd, "migrations", "0001_init.catalog.json"), "utf8");
        const legacy = catalogHash(parseCatalog(stored));
        const startup = await storedHashes(sql);
        expect(startup.meta).not.toBe(legacy);

        const foreign = "f".repeat(64);
        await stamp(sql, foreign);
        expect(await output(["migrate", "apply"], cwd)).toBe("target default\nnothing to apply\n");
        expect(await storedHashes(sql)).toEqual({ meta: foreign, history: [foreign] });

        await stamp(sql, legacy);
        expect(await connectCode(url)).toBe("OKM1520");
        const refused = await rejected(["migrate", "apply"], cwd);
        expect(refused.code).toBe("OKM1850");
        expect(refused.message).toContain("history-repair");
        expect(await storedHashes(sql)).toEqual({ meta: legacy, history: [legacy] });

        expect(await output(["migrate", "apply", "--allow-protected"], cwd)).toBe(
          "target default\nrestamped 0001_init\nnothing to apply\n",
        );
        expect(await storedHashes(sql)).toEqual(startup);
        await expectConnects(url);
        expect(await output(["migrate", "apply"], cwd)).toBe("target default\nnothing to apply\n");
      },
      { protected: true },
    );
  },
  90_000,
);

postgresTest(
  gate,
  "the reference schema passes every check and connects without catalogDir",
  async () => {
    const fixture = JSON.stringify(join(root, "tests/fixtures/reference-app/schema.ts"));
    await withRolesProject(`export { app } from ${fixture};`, async ({ cwd, url }) => {
      await output(["generate", "init"], cwd);
      await output(["migrate", "apply"], cwd);
      expect(await output(["check"], cwd)).toBe("ok\n");
      expect(await output(["migrate", "check"], cwd)).toBe("ok 1 migrations\n");
      expect(await output(["migrate", "check", "--provision"], cwd)).toBe("ok 1 migrations\n");
      const db = connect(url, { schema: reference, max: 1 });
      try {
        const scoped = db.for({ workspaceId: "00000000-0000-4000-8000-000000000001" });
        const project = await scoped.projects.insert({ name: "Launch", slug: "launch" });
        await scoped.tasks.insert({ projectId: project.id, title: "Ship", status: "todo" });
        await scoped.tasks.insert({ projectId: project.id, title: "Plan", status: "done" });
        const open = await scoped.views.openTasks.find({ limit: 5 });
        expect(open).toEqual([
          {
            workspaceId: "00000000-0000-4000-8000-000000000001",
            projectId: project.id,
            openTasks: "1",
          },
        ]);
        const active = await scoped.views.activeProjects.find({ limit: 5, select: ["name"] });
        expect(active).toEqual([{ name: "Launch" }]);
      } finally {
        await db.close();
      }
    });
  },
  120_000,
);

function roleName(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function urlAs(base: string, user: string, password: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  return url.href;
}

function project(
  root: string,
  url: string,
  roles: { readonly migration: string; readonly app: string },
): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-roles-"));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
      `export const app = schema({ tables: [table("tasks", { id: t.text().primaryKey(), title: t.text() })] });`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      `  database: ${JSON.stringify(url)},`,
      `  roles: { migration: ${JSON.stringify(roles.migration)}, app: ${JSON.stringify(roles.app)} },`,
      "});",
      "",
    ].join("\n"),
  );
  return cwd;
}

/**
 * Runs `body` in a project whose config manages one fresh app role.
 *
 * The migration role is the connecting user, so apply issues no `SET ROLE`.
 */
async function withRolesProject(
  schemaBody: string,
  body: (context: { cwd: string; url: string; sql: Sql }) => Promise<void>,
  options?: { readonly protected?: boolean },
): Promise<void> {
  const app = roleName("app");
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  const cwd = mkdtempSync(join(tmpdir(), "okm-roles-"));
  try {
    writeProject(cwd, database.url, { app }, schemaBody, options);
    await body({ cwd, url: database.url, sql });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await sql.end({ timeout: 5 });
    await database.close();
    await dropRoles([app]);
  }
}

function writeProject(
  cwd: string,
  url: string,
  roles: { readonly app: string },
  schemaBody: string,
  options?: { readonly protected?: boolean },
): void {
  const source = (path: string): string => JSON.stringify(join(root, path));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, table, t } from ${source("src/dialects/pg/index.ts")};`,
      `import { fn } from ${source("src/dialects/pg/fn/index.ts")};`,
      schemaBody,
      "",
    ].join("\n"),
  );
  const migration = decodeURIComponent(new URL(url).username);
  const database =
    options?.protected === true
      ? `{ url: ${JSON.stringify(url)}, protected: true }`
      : JSON.stringify(url);
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${source("src/tooling/migrate/index.ts")};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${database},`,
      `  roles: { migration: ${JSON.stringify(migration)}, app: ${JSON.stringify(roles.app)}, managed: [{ name: ${JSON.stringify(roles.app)} }] },`,
      "});",
      "",
    ].join("\n"),
  );
}

async function output(argv: readonly string[], cwd: string): Promise<string> {
  const lines: string[] = [];
  await run(argv, { cwd, stdout: (text) => lines.push(text) });
  return lines.join("");
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

/** Every ACL in `public`, the schema's own, and every default privilege, one per line. */
async function targetAcl(sql: Sql): Promise<string> {
  const rows = await sql<{ entry: string }[]>`
    select 'relation ' || c.relname::text || ' ' || coalesce(c.relacl::text, '') as entry
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
    union all
    select 'function ' || p.proname::text || ' ' || coalesce(p.proacl::text, '')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
    union all
    select 'schema public ' || coalesce(nspacl::text, '') from pg_namespace where nspname = 'public'
    union all
    select 'default ' || coalesce(n.nspname::text, '') || ' ' || d.defaclobjtype::text || ' ' || d.defaclacl::text
      from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
    order by 1
  `;
  return rows.map((row) => row.entry).join("\n");
}

async function storedHashes(sql: Sql): Promise<{ meta: string; history: string[] }> {
  const meta = await sql<{ catalog_hash: string }[]>`select catalog_hash from okm_meta`;
  const history = await sql<{ catalog_hash: string }[]>`
    select catalog_hash from okm_history order by migration_id, step_index
  `;
  return { meta: meta[0]?.catalog_hash ?? "", history: history.map((row) => row.catalog_hash) };
}

async function stamp(sql: Sql, hash: string): Promise<void> {
  await sql`update okm_meta set catalog_hash = ${hash}`;
  await sql`update okm_history set catalog_hash = ${hash}`;
}

function tasksSchema() {
  return schema({ tables: [table("tasks", { id: t.text().primaryKey(), title: t.text() })] });
}

async function connectCode(url: string): Promise<string> {
  const db = connect(url, { schema: tasksSchema(), max: 1 });
  try {
    await db.tasks.find({ limit: 1 });
    return "connected";
  } catch (error) {
    return error instanceof OkmError ? error.code : String(error);
  } finally {
    await db.close();
  }
}

async function expectConnects(url: string): Promise<void> {
  expect(await connectCode(url)).toBe("connected");
}

async function dropRoles(names: readonly string[]): Promise<void> {
  const admin = openPostgres();
  try {
    for (const name of names) await admin.unsafe(`drop role if exists ${quoteIdent(name)}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

function queryOf(sql: Sql): CatalogQuery {
  return {
    async query(text, params) {
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return rows.map((row) => {
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) copy[key] = value;
        return copy;
      });
    },
  };
}
