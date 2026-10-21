/**
 * Shared fixture for the F8 SQL option tests (`countDistinct`, `distinct`,
 * named aggregations, `having`, null ordering) on real Postgres.
 *
 * One tenant table with NULL rows in every nullable column, so each test sees
 * the NULL, empty-group, and tenant-isolation cases without a mock. PGlite
 * always runs. postgres.js, node-postgres, and Bun.sql run when the topology
 * is up.
 */

import { test } from "bun:test";

import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { integer, schema, table, text, timestamptz, uuid } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import type { Connected } from "../src/runtime/types.js";

export const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";
export const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c22";

export const sales = table("sales", {
  id: uuid().primaryKey(),
  region: text(),
  customer: text().nullable(),
  amount: integer().nullable(),
  channel: text().nullable(),
  seenAt: timestamptz().nullable(),
  secret: text().hidden(),
});

export const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [sales],
});

export type Db = Connected<typeof app>;
export type Scoped = ReturnType<Db["for"]>;

const day = (text: string): Temporal.Instant => Temporal.Instant.from(`${text}T00:00:00Z`);

/**
 * Tenant A holds seven rows and tenant B one. Every nullable column has a NULL.
 *
 * | region | customer | amount | channel | seenAt |
 * | --- | --- | ---: | --- | --- |
 * | north | c1 | 10 | web | 2026-01-02 |
 * | north | c1 | 20 | web | 2026-01-02 |
 * | north | c2 | null | app | 2026-01-01 |
 * | north | null | 5 | null | null |
 * | south | c3 | 7 | web | null |
 * | south | c3 | null | web | null |
 * | east | null | null | null | null |
 *
 * Tenant B: north, c9, 1000, web, 2026-03-01.
 */
export async function seed(db: Db): Promise<{ readonly a: Scoped; readonly b: Scoped }> {
  const a = db.for({ tenantId: TENANT_A });
  const b = db.for({ tenantId: TENANT_B });
  const rows = [
    ["north", "c1", 10, "web", day("2026-01-02")],
    ["north", "c1", 20, "web", day("2026-01-02")],
    ["north", "c2", null, "app", day("2026-01-01")],
    ["north", null, 5, null, null],
    ["south", "c3", 7, "web", null],
    ["south", "c3", null, "web", null],
    ["east", null, null, null, null],
  ] as const;
  for (const [region, customer, amount, channel, seenAt] of rows) {
    await a.sales.insert({
      id: crypto.randomUUID(),
      secret: "x",
      region,
      customer,
      amount,
      channel,
      seenAt,
    });
  }
  await b.sales.insert({
    id: crypto.randomUUID(),
    secret: "x",
    region: "north",
    customer: "c9",
    amount: 1000,
    channel: "web",
    seenAt: day("2026-03-01"),
  });
  return { a, b };
}

/**
 * Awaits a call that must be refused.
 *
 * @param pending - The call
 * @returns The `OkmError` it rejected with
 */
export async function caught(pending: PromiseLike<unknown>): Promise<OkmError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}

const gate = await loadPostgresGate();

/**
 * Registers one test per driver. Each run gets an empty `sales` table.
 *
 * @param title - Test title, followed by the driver name
 * @param prove - Test body
 */
export function onEveryDriver(title: string, prove: (db: Db) => Promise<void>): void {
  test(`${title} on pglite`, async () => {
    const pool = await openPglite();
    try {
      for (const statement of renderCatalog(app.catalog, "public")) await pool.execute(statement);
      const db = await connectPglite(pool, { schema: app });
      await db.connected;
      try {
        await prove(db);
      } finally {
        await db.close();
      }
    } finally {
      await pool.close();
    }
  }, 60_000);
  for (const driver of ["postgres.js", "node-postgres", "bun.sql"] as const) {
    postgresTest(
      gate,
      `${title} on ${driver}`,
      async () => {
        await withPostgresSchema(async (sql, schemaName) => {
          for (const statement of renderCatalog(app.catalog, schemaName)) {
            await sql.unsafe(statement);
          }
          const options = { schema: app, searchPath: schemaName, max: 1 };
          const db =
            driver === "postgres.js"
              ? connectPostgres(primaryUrl(), options)
              : driver === "node-postgres"
                ? connectPg(primaryUrl(), options)
                : connectBun(primaryUrl(), options);
          await db.connected;
          try {
            await prove(db);
          } finally {
            await db.close();
          }
        });
      },
      60_000,
    );
  }
}
