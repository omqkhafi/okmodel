/**
 * Gate checks for the 0.6 access train on real Postgres.
 *
 * These are the cases the earlier files do not pin together: a three-hop
 * parent move, the reporting role under row-level security, ownership through
 * apply and drift, and `connect()` on a table created by hand.
 */

import { expect } from "bun:test";

import { startupHash } from "../src/contracts/catalog/document.js";
import { OkmError } from "../src/contracts/error.js";
import { quoteIdent, renderCatalog } from "../src/dialects/pg/ddl.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, table, t, withOwner } from "../src/dialects/pg/index.js";
import { stampOwnership } from "../src/dialects/pg/owner.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  createIsolatedDatabase,
  openPostgres,
  withPostgresSchema,
} from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import {
  columnTenancy,
  compositeTenancy,
  rlsTenancy,
  type ColumnTenancy,
} from "../src/runtime/tenancy/index.js";
import { tenantProbe } from "../src/tooling/testing/facts.js";
import { testing } from "../src/tooling/testing/index.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { DEPT, NOTE, ORG, pathApp, TEAM, TENANT_A, TENANT_B } from "./tenancy-strategies-schema.js";

const ORG_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c62";
const DEPT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c63";
const TEAM_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c64";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "a three-hop update cannot move a child onto another tenant's parent",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(pathApp.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: pathApp, searchPath: schemaName, max: 2 });
      try {
        await db.connected;
        const a = db.for({ tenantId: TENANT_A });
        const b = db.for({ tenantId: TENANT_B });
        await a.organizations.insert({ id: ORG, name: "Alpha" });
        await a.departments.insert({ id: DEPT, name: "Eng", organizationId: ORG });
        await a.teams.insert({ id: TEAM, name: "Core", departmentId: DEPT });
        await a.notes.insert({ id: NOTE, body: "secret", teamId: TEAM });
        await b.organizations.insert({ id: ORG_B, name: "Beta" });
        await b.departments.insert({ id: DEPT_B, name: "Eng", organizationId: ORG_B });
        await b.teams.insert({ id: TEAM_B, name: "Other", departmentId: DEPT_B });

        await expectCode(
          a.notes.update({ where: { id: NOTE }, set: { teamId: TEAM_B } }),
          "OKM1705",
        );
        expect((await a.notes.one({ where: { id: NOTE } }))?.teamId).toBe(TEAM);
        expect((await a.notes.one({ where: { id: NOTE } }))?.body).toBe("secret");
        expect(await b.notes.find({ where: { id: NOTE }, limit: 5 })).toEqual([]);
        await expectCode(
          a.notes.insert(
            { id: crypto.randomUUID(), body: "other", teamId: TEAM },
            { onConflict: { on: "body", return: true } },
          ),
          "OKM1120",
        );
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "the reporting role cannot write, cannot read a hidden column, and row-level security still applies",
  async () => {
    const people = table("people", { email: t.text(), secret: t.text().hidden() });
    const built = schema({
      casing: "snake",
      tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
      tables: [people],
    });
    await withPostgresSchema(async (admin, schemaName) => {
      for (const statement of renderCatalog(built.catalog, schemaName)) {
        await admin.unsafe(statement);
      }
      const report = `r_${schemaName}`;
      await admin.unsafe(
        `create role ${quoteIdent(report)} login password 'secret' nosuperuser nobypassrls nocreatedb`,
      );
      try {
        await admin.unsafe(
          `grant usage on schema ${quoteIdent(schemaName)} to ${quoteIdent(report)}`,
        );
        await admin.unsafe(
          `grant select ("email") on ${quoteIdent(schemaName)}.people to ${quoteIdent(report)}`,
        );
        await admin.unsafe(
          `insert into people (tenant_id, email, secret) values ('${TENANT_A}', 'ada@acme.test', 'hidden')`,
        );
        const bypass = await admin<{ rolbypassrls: boolean }[]>`
          select rolbypassrls from pg_roles where rolname = ${report}
        `;
        expect(bypass[0]?.rolbypassrls).toBe(false);
        expect(await denied(admin, report, `select secret from people`)).toBe("42501");
        expect(await denied(admin, report, `insert into people (email) values ('x')`)).toBe(
          "42501",
        );
        expect(await denied(admin, report, `update people set email = 'x'`)).toBe("42501");
        expect(await denied(admin, report, `delete from people`)).toBe("42501");
        const seen = await asRole(admin, report, `select count(*)::text as n from people`);
        expect(seen).toBe("0");
        await admin.unsafe("begin");
        try {
          await admin.unsafe(`set local role ${quoteIdent(report)}`);
          await admin.unsafe(`select set_config('app.tenant', '${TENANT_A}', true)`);
          const scoped = await admin.unsafe(`select count(*)::text as n from people`);
          const count = scoped[0] === undefined ? "" : String(Object.values(scoped[0])[0]);
          expect(count).toBe("1");
          await admin.unsafe("commit");
        } catch (error) {
          await admin.unsafe("rollback");
          throw error;
        }
        const after = await admin.unsafe(`select current_setting('app.tenant', true) as tenant`);
        expect(String(Object.values(after[0] ?? {})[0] ?? "")).toBe("");
        const again = await asRole(admin, report, `select count(*)::text as n from people`);
        expect(again).toBe("0");
      } finally {
        await admin.unsafe(`reset role`);
        await admin.unsafe(`drop owned by ${quoteIdent(report)}`);
        await admin.unsafe(`drop role if exists ${quoteIdent(report)}`);
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "ignored and external tables survive apply and a later drift plan",
  async () => {
    const people = table("people", { id: t.text().primaryKey(), name: t.text() });
    const built = schema({ tables: [people] });
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const hash = startupHash(built.catalog);
      await applyTarget({
        url: database.url,
        target: "default",
        protected: false,
        snapshot: {
          catalog: built.catalog,
          migrationId: "0001_people",
          catalogHash: hash,
          reference: [],
        },
        migrations: [],
      });
      await sql.unsafe(`insert into people (id, name) values ('a', 'Ada')`);
      const ignored = stampOwnership(built.catalog, new Map([["people", "ignored"]]));
      const marked = planMigration({ before: built.catalog, after: ignored, name: "mark" });
      expect(marked.steps).toEqual([]);
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const drift = planMigration({ before: live, after: ignored, name: "drift" }).steps.map(
        (step) => step.sql,
      );
      expect(drift.some((step) => /drop table|drop column|alter table/i.test(step))).toBe(false);
      expect(await sql<{ name: string }[]>`select name from people`).toEqual([{ name: "Ada" }]);

      await sql.unsafe(`create table notes (id text primary key, body text, extra text)`);
      const notes = withOwner(
        table("notes", { id: t.text().primaryKey(), body: t.text() }),
        "external",
      );
      const externalCatalog = stampOwnership(
        schema({ tables: [notes] }).catalog,
        new Map([["notes", "external"]]),
      );
      const adopted = await introspectSchema(queryOf(sql), "public", "public");
      const externalPlan = planMigration({
        before: adopted,
        after: externalCatalog,
        name: "external",
      }).steps.map((step) => step.sql);
      expect(externalPlan.some((step) => step.toLowerCase().includes("notes"))).toBe(false);
      expect(await sql<{ extra: string | null }[]>`select extra from notes`).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a hand-created table connects, and requireMeta is OKM1520 until a stamp exists",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table tasks (id text primary key, title text, unique (title))`);
      const app = schema({
        tables: [table("tasks", { id: t.text().primaryKey(), title: t.text().unique() })],
      });
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        await db.tasks.insert({ id: "a", title: "one" });
        expect(await db.tasks.count()).toBe(1);
      } finally {
        await db.close();
      }
      const strict = connect(primaryUrl(), {
        schema: app,
        searchPath: schemaName,
        max: 1,
        requireMeta: true,
      });
      try {
        await expectCode(strict.connected, "OKM1520");
      } finally {
        await strict.close();
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "isolation fails when a predicate or a policy is removed",
  async () => {
    await expectLeak(
      () => columnTenancy({ key: "tenantId", type: "uuid" }),
      (tenancy) =>
        schema({
          tenancy,
          tables: [table("notes", { id: t.text().primaryKey(), title: t.text() })],
        }),
      ["notes"],
    );
    await expectLeak(
      () => compositeTenancy({ key: ["organizationId", "workspaceId"], type: "uuid" }),
      (tenancy) =>
        schema({
          tenancy,
          tables: [table("documents", { id: t.text().primaryKey(), title: t.text() })],
        }),
      ["documents"],
    );

    const database = await createIsolatedDatabase();
    const admin = openPostgres(database.url);
    const appRole = `p86_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    try {
      const people = table("people", { id: t.text().primaryKey(), email: t.text() });
      const built = schema({
        casing: "snake",
        tenancy: rlsTenancy({ key: "tenantId", type: "uuid" }),
        tables: [people],
      });
      for (const statement of renderCatalog(built.catalog, "public")) {
        await admin.unsafe(statement);
      }
      await admin.unsafe(
        `create role ${quoteIdent(appRole)} login password 'secret' nosuperuser nobypassrls`,
      );
      await admin.unsafe(
        `grant connect on database ${quoteIdent(databaseName(database.url))} to ${quoteIdent(appRole)}`,
      );
      await admin.unsafe(`grant usage on schema public to ${quoteIdent(appRole)}`);
      await admin.unsafe(
        `grant select, insert, update, delete on all tables in schema public to ${quoteIdent(appRole)}`,
      );
      const appUrl = roleUrl(database.url, appRole);
      const harness = await testing(built, {
        driver: open({ url: appUrl, max: 2 }),
        migrate: false,
      });
      try {
        const report = await harness.isolation();
        expect(report.checked).toContain("people");
      } finally {
        await harness.close();
      }
      await admin.unsafe(`drop policy if exists people_tenant on people`);
      await admin.unsafe(`drop policy if exists people_unscoped_select on people`);
      await admin.unsafe(`alter table people disable row level security`);
      const leaking = await testing(built, {
        driver: open({ url: appUrl, max: 2 }),
        migrate: false,
      });
      try {
        await expectIsolationError(leaking.isolation());
      } finally {
        await leaking.close();
      }
    } finally {
      await admin.unsafe(`drop owned by ${quoteIdent(appRole)}`);
      await admin.unsafe(`drop role if exists ${quoteIdent(appRole)}`);
      await admin.end({ timeout: 5 });
      await database.close();
    }
  },
  90_000,
);

async function expectLeak(
  fresh: () => ColumnTenancy,
  build: (tenancy: ColumnTenancy) => Parameters<typeof testing>[0],
  checked: readonly string[],
): Promise<void> {
  const database = await createIsolatedDatabase();
  try {
    const tenancy = fresh();
    const harness = await testing(build(tenancy), { driver: open({ url: database.url }) });
    try {
      const report = await harness.isolation();
      for (const name of checked) expect(report.checked).toContain(name);
    } finally {
      await harness.close();
    }
    const stripped: ColumnTenancy = {
      ...tenancy,
      predicate(input: Parameters<ColumnTenancy["predicate"]>[0]): boolean {
        if (
          input.scope !== undefined &&
          "value" in input.scope &&
          input.scope.value === tenantProbe
        ) {
          return tenancy.predicate(input);
        }
        return false;
      },
    };
    const leaking = await testing(build(stripped), {
      driver: open({ url: database.url }),
      migrate: false,
    });
    try {
      await expectIsolationError(leaking.isolation());
    } finally {
      await leaking.close();
    }
  } finally {
    await database.close();
  }
}

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

function roleUrl(url: string, role: string): string {
  const next = new URL(url);
  next.username = role;
  next.password = "secret";
  return next.href;
}

async function expectIsolationError(pending: Promise<unknown>): Promise<void> {
  let failure: unknown;
  try {
    await pending;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(OkmError);
  const message = failure instanceof OkmError ? failure.message : "";
  expect(message.includes("Isolation leak") || message.includes("row-level security")).toBe(true);
}

async function expectCode(pending: Promise<unknown>, code: string): Promise<void> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
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
