/**
 * Roles, grants, and default privileges on Postgres.
 *
 * The application role is not the owner. Later objects are reachable through
 * default privileges. A missing `CREATEROLE` stops apply before any statement.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
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

const gate = await loadPostgresGate();

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
        .filter((statement) => /role|grant|revoke|default privileges/i.test(statement))
        .filter(
          (statement) => !statement.includes("okm_meta") && !statement.includes("okm_history"),
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
    const root = repoRoot();
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
