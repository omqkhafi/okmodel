/**
 * Reasons through `connect()`, on Postgres 15 and 18.
 *
 * The strings are the ones application code already matches: the stored name
 * key, not the SQL spelling of the constraint. Column tenancy and composite
 * tenancy each cover the extra unique, a single `.unique()`, a named unique,
 * a tenant foreign key, and an archivable partial unique.
 */

import { expect } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy, compositeTenancy } from "../src/runtime/tenancy/index.js";
import { archivable } from "../src/runtime/traits/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const ID_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c11";
const ID_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c12";
const TENANT = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";
const ORG = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";
const MISSING = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c22";
const WORKSPACE = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c31";

const columnApp = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [
    table("orgs", { id: id({ default: "none" }), name: text() }),
    table("users", { id: id({ default: "none" }), email: text().unique() }),
    table(
      "accounts",
      { id: id({ default: "none" }), email: text() },
      { unique: { email_taken: ["email"] } },
    ),
    table("tasks", {
      id: id({ default: "none" }),
      title: text(),
      orgId: uuid().references("orgs"),
    }),
    table(
      "items",
      { id: id({ default: "none" }), title: text().unique() },
      { traits: [archivable()] },
    ),
  ],
});

const compositeApp = schema({
  casing: "snake",
  tenancy: compositeTenancy({ key: ["organizationId", "workspaceId"], type: "uuid" }),
  tables: [
    table("orgs", { id: id({ default: "none" }), name: text() }),
    table("users", { id: id({ default: "none" }), email: text().unique() }),
    table(
      "accounts",
      { id: id({ default: "none" }), email: text() },
      { unique: { email_taken: ["email"] } },
    ),
    table("tasks", {
      id: id({ default: "none" }),
      title: text(),
      orgId: uuid().references("orgs"),
    }),
    table(
      "items",
      { id: id({ default: "none" }), title: text().unique() },
      { traits: [archivable()] },
    ),
  ],
});

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "column tenancy reasons stay the stored name keys through the client",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(columnApp.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: columnApp, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        const scoped = db.for({ tenantId: TENANT });
        await scoped.orgs.insert({ id: ORG, name: "Acme" });
        await scoped.users.insert({ id: ID_A, email: "a@b.c" });
        await expectReason(scoped.users.insert({ id: ID_B, email: "a@b.c" }), "email");
        await scoped.accounts.insert({ id: ID_A, email: "a@b.c" });
        await expectReason(scoped.accounts.insert({ id: ID_B, email: "a@b.c" }), "email_taken");
        await scoped.tasks.insert({ id: ID_A, title: "one", orgId: ORG });
        // The extra unique repeats the primary key, so Postgres raises `tasks_pkey`
        // until that constraint is gone. The unique is the one whose name changed.
        await sql.unsafe(`alter table tasks drop constraint tasks_pkey`);
        await expectReason(
          scoped.tasks.insert({ id: ID_A, title: "two", orgId: ORG }),
          "id_tenantId",
        );
        await expectReason(
          scoped.tasks.insert({ id: ID_B, title: "three", orgId: MISSING }),
          "org_id",
        );
        await scoped.items.insert({ id: ID_A, title: "one" });
        await expectReason(
          scoped.items.insert({ id: ID_B, title: "one" }),
          "items_tenant_id_title_idx",
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
  "composite tenancy reasons stay the stored name keys through the client",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(compositeApp.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: compositeApp, searchPath: schemaName, max: 1 });
      try {
        await db.connected;
        const scoped = db.for({ organizationId: ORG, workspaceId: WORKSPACE });
        await scoped.orgs.insert({ id: ORG, name: "Acme" });
        await scoped.users.insert({ id: ID_A, email: "a@b.c" });
        await expectReason(scoped.users.insert({ id: ID_B, email: "a@b.c" }), "email");
        await scoped.accounts.insert({ id: ID_A, email: "a@b.c" });
        await expectReason(scoped.accounts.insert({ id: ID_B, email: "a@b.c" }), "email_taken");
        await scoped.tasks.insert({ id: ID_A, title: "one", orgId: ORG });
        await sql.unsafe(`alter table tasks drop constraint tasks_pkey`);
        await expectReason(
          scoped.tasks.insert({ id: ID_A, title: "two", orgId: ORG }),
          "id_organizationId_workspaceId",
        );
        await expectReason(
          scoped.tasks.insert({ id: ID_B, title: "three", orgId: MISSING }),
          "org_id",
        );
        await scoped.items.insert({ id: ID_A, title: "one" });
        await expectReason(
          scoped.items.insert({ id: ID_B, title: "one" }),
          "items_organization_id_workspace_id_title_idx",
        );
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);

async function expectReason(pending: Promise<unknown>, reason: string): Promise<void> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.fieldReason).toBe(reason);
      expect(error.constraint).toBeDefined();
    }
    return;
  }
  throw new Error(`expected ${reason}`);
}
