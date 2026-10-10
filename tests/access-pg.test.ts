/**
 * Column grants, the reporting role, and `okm_meta` select on Postgres.
 *
 * The application role reads the stored hash. A column grant allows the
 * named column and refuses another. The reporting role cannot write.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";

import { startupHash } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/error.js";
import { quoteIdent } from "../src/dialects/pg/ddl.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { attachRoles, type TableExposure } from "../src/dialects/pg/role/index.js";
import { assertRoleHealth } from "../src/dialects/pg/role/check.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import { doctorProject } from "../src/tooling/migrate/doctor.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();
const root = repoRoot();

postgresTest(
  gate,
  "column grants, the reporting role, and okm_meta select",
  async () => {
    const mig = roleName("mig");
    const app = roleName("app");
    const report = roleName("report");
    const reader = roleName("reader");
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const people = table("people", { email: t.text(), secret: t.text().hidden() });
    const built = schema({ tables: [people] });
    const exposure: TableExposure[] = Object.values(built.model).map((model) => ({
      table: model.sql,
      columns: model.columns.map((column) => ({
        field: column.field,
        sql: column.sql,
        hidden: column.hidden === true || column.hidden === "filter",
      })),
    }));
    const declared = attachRoles(
      built.catalog,
      {
        migration: mig,
        app,
        reporting: report,
        managed: [{ name: mig }],
        columns: [{ role: reader, on: "people", select: ["email"] }],
      },
      exposure,
    );
    try {
      await sql.unsafe(
        `create role ${quoteIdent(app)} login password 'secret' nosuperuser nocreatedb nocreaterole`,
      );
      await sql.unsafe(
        `create role ${quoteIdent(report)} login password 'secret' nosuperuser nocreatedb nocreaterole`,
      );
      await sql.unsafe(
        `create role ${quoteIdent(reader)} login password 'secret' nosuperuser nocreatedb nocreaterole`,
      );
      const hash = startupHash(declared);
      await applyTarget({
        url: database.url,
        target: "default",
        protected: false,
        migrationRole: mig,
        appRole: app,
        snapshot: {
          catalog: declared,
          migrationId: "0001_access",
          catalogHash: hash,
          reference: [],
        },
        migrations: [],
      });
      const meta = await asRole(sql, app, `select catalog_hash from okm_meta where id = 'head'`);
      expect(meta).toBe(hash);
      expect(
        await denied(sql, app, `insert into okm_meta (id, catalog_hash) values ('x', 'y')`),
      ).toBe("42501");
      const client = connect(urlAs(database.url, app, "secret"), {
        schema: schema({
          tables: [table("people", { email: t.text(), secret: t.text().hidden() })],
        }),
        max: 1,
        requireMeta: true,
      });
      try {
        await client.connected;
      } finally {
        await client.close();
      }
      expect(await asRole(sql, reader, `select email from people`)).toBe(null);
      expect(await denied(sql, reader, `select secret from people`)).toBe("42501");
      expect(await asRole(sql, report, `select email from people`)).toBe(null);
      expect(await denied(sql, report, `select secret from people`)).toBe("42501");
      expect(await denied(sql, report, `insert into people (email) values ('a')`)).toBe("42501");

      const live = await introspectSchema(queryOf(sql), "public", "public", {
        managedRoles: [mig, app, report],
        reportingRole: report,
      });
      const drift = planMigration({ before: live, after: declared, name: "drift" })
        .steps.map((step) => step.sql)
        .filter((statement) => /role|grant|revoke|default privileges/i.test(statement));
      expect(drift).toEqual([]);

      await sql.unsafe(`revoke select on okm_meta from ${quoteIdent(app)}`);
      await applyTarget({
        url: database.url,
        target: "default",
        protected: false,
        migrationRole: mig,
        appRole: app,
        snapshot: {
          catalog: declared,
          migrationId: "0001_access",
          catalogHash: hash,
          reference: [],
        },
        migrations: [],
      });
      expect(await asRole(sql, app, `select catalog_hash from okm_meta where id = 'head'`)).toBe(
        hash,
      );

      const cwd = project(database.url, { migration: mig, app, reporting: report, reader });
      try {
        const pool = open({ url: database.url, max: 1 });
        try {
          await assertRoleHealth(
            pool,
            {
              migration: mig,
              app,
              reporting: report,
              columns: [{ role: reader, on: "people", select: ["email"] }],
            },
            declared.objects,
          );
          expect(await doctorProject(cwd, undefined)).toBe("no triggers\n");
        } finally {
          await pool.close();
        }
        await sql.unsafe(`revoke select (email) on people from ${quoteIdent(reader)}`);
        let caught: unknown;
        try {
          await doctorProject(cwd, undefined);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(OkmError);
        expect((caught as OkmError).code).toBe("OKM1825");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
      await dropRoles([mig, app, report, reader]);
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
  url: string,
  roles: {
    readonly migration: string;
    readonly app: string;
    readonly reporting: string;
    readonly reader: string;
  },
): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-access-"));
  const source = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const config = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, table, t } from ${source};`,
      `export const app = schema({ tables: [table("people", { email: t.text(), secret: t.text().hidden() })] });`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${config};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      `  database: ${JSON.stringify(url)},`,
      "  roles: {",
      `    migration: ${JSON.stringify(roles.migration)},`,
      `    app: ${JSON.stringify(roles.app)},`,
      `    reporting: ${JSON.stringify(roles.reporting)},`,
      `    columns: [{ role: ${JSON.stringify(roles.reader)}, on: "people", select: ["email"] }],`,
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  return cwd;
}

async function asRole(
  sql: ReturnType<typeof openPostgres>,
  role: string,
  statement: string,
): Promise<string | null> {
  await sql.unsafe(`set role ${quoteIdent(role)}`);
  try {
    const rows = await sql.unsafe(statement);
    const value = rows[0] === undefined ? null : Object.values(rows[0])[0];
    return value === null || value === undefined ? null : String(value);
  } finally {
    await sql.unsafe("reset role");
  }
}

async function denied(
  sql: ReturnType<typeof openPostgres>,
  role: string,
  statement: string,
): Promise<string> {
  await sql.unsafe(`set role ${quoteIdent(role)}`);
  try {
    await sql.unsafe(statement);
    return "";
  } catch (error) {
    return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
      ? error.code
      : "";
  } finally {
    await sql.unsafe("reset role");
  }
}

function queryOf(sql: ReturnType<typeof openPostgres>): CatalogQuery {
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
