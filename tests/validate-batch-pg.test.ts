/**
 * Validation and batch share one path: a validated insert/update still plans
 * for `batch`, and a failing rule rolls the unit back with OKM1200 + batchIndex.
 * `isolation()` uses that path on a tenant table.
 */

import { expect, test } from "bun:test";

import { open as openBun } from "../src/adapters/pg/bunsql.js";
import { open as openPg } from "../src/adapters/pg/nodepostgres.js";
import { open as openPglitePool } from "../src/adapters/pg/pglite.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import { OkmError } from "../src/contracts/index.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, schema, table, text, uuid, varchar } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { v } from "../src/runtime/validate/index.js";
import { testing } from "../src/tooling/testing/index.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";
const ID_D = "44444444-4444-4444-8444-444444444444";

const notes = table(
  "notes",
  {
    id: uuid().primaryKey(),
    title: varchar(8).validate([v.trim(), v.min(1, "title_required")]),
  },
  { validation: true },
);

const app = schema({ tables: [notes], validation: true });

const tenantNotes = table(
  "notes",
  {
    id: id({ default: "none" }),
    title: text().validate([v.trim(), v.min(1, "title_required")]),
  },
  { validation: true },
);

const tenantApp = schema({
  tables: [tenantNotes],
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  validation: true,
});

const gate = await loadPostgresGate();

type Driver = "postgresjs" | "pg" | "bun" | "pglite";

type Db = {
  readonly connected: Promise<void>;
  notes: {
    insert(
      row: { id: string; title: string },
      options?: { validate?: boolean },
    ): Promise<{ readonly title: string }>;
    update(input: {
      where: { id: string };
      set: { title: string };
    }): Promise<{ readonly count: number }>;
    delete(input: { where: { id: string } }): Promise<{ readonly count: number }>;
    one(input: { where: { id: string } }): Promise<{ readonly title: string } | null>;
    find(input: { limit: number }): Promise<readonly unknown[]>;
  };
  batch(ops: readonly unknown[]): Promise<readonly unknown[]>;
  close(): Promise<void>;
};

async function openDriver(
  driver: Driver,
  schemaName: string | undefined,
): Promise<{ readonly db: Db; readonly close: () => Promise<void> }> {
  if (driver === "pglite") {
    const pool = await openPglitePool();
    for (const statement of renderCatalog(app.catalog, "public")) await pool.execute(statement);
    const db = (await connectPglite(pool, { schema: app })) as unknown as Db;
    return {
      db,
      close: async () => {
        await db.close();
        await pool.close();
      },
    };
  }
  const url = primaryUrl();
  const path = schemaName ?? "public";
  const options = { schema: app, searchPath: path, max: 1 };
  if (driver === "postgresjs") {
    const db = connectPostgres(
      openPostgres({ url, searchPath: path, max: 1 }),
      options,
    ) as unknown as Db;
    return { db, close: () => db.close() };
  }
  if (driver === "pg") {
    const db = connectPg(openPg({ url, searchPath: path, max: 1 }), options) as unknown as Db;
    return { db, close: () => db.close() };
  }
  const db = connectBun(openBun({ url, searchPath: path, max: 1 }), options) as unknown as Db;
  return { db, close: () => db.close() };
}

async function proveBatch(db: Db): Promise<void> {
  await db.connected;

  const results = await db.batch([
    db.notes.insert({ id: ID_A, title: "  one  " }),
    db.notes.update({ where: { id: ID_A }, set: { title: "  two  " } }),
    db.notes.delete({ where: { id: ID_A } }),
  ]);
  expect(results).toHaveLength(3);
  expect(await db.notes.one({ where: { id: ID_A } })).toBeNull();

  await db.notes.insert({ id: ID_B, title: "kept" });
  let failed: OkmError | undefined;
  try {
    await db.batch([
      db.notes.insert({ id: ID_C, title: "ok" }),
      db.notes.update({ where: { id: ID_B }, set: { title: "" } }),
      db.notes.delete({ where: { id: ID_B } }),
    ]);
  } catch (error) {
    if (error instanceof OkmError) failed = error;
    else throw error;
  }
  expect(failed?.code).toBe("OKM1200");
  expect(failed?.batchIndex).toBe(1);
  expect(failed?.issues?.map((issue) => issue.message)).toEqual(["title_required"]);
  expect(await db.notes.one({ where: { id: ID_B } })).toMatchObject({ title: "kept" });
  expect(await db.notes.one({ where: { id: ID_C } })).toBeNull();
  await db.notes.delete({ where: { id: ID_B } });

  await db.notes.insert({ id: ID_D, title: "   " }, { validate: false });
  const raw = await db.notes.one({ where: { id: ID_D } });
  expect(raw?.title).toBe("   ");
  await db.batch([
    db.notes.update({ where: { id: ID_D }, set: { title: "  pad  " } }),
    db.notes.delete({ where: { id: ID_D } }),
  ]);
  expect(await db.notes.one({ where: { id: ID_D } })).toBeNull();
}

test("pglite: validation true batch and rollback", async () => {
  const { db, close } = await openDriver("pglite", undefined);
  try {
    await proveBatch(db);
  } finally {
    await close();
  }
}, 30_000);

for (const driver of ["postgresjs", "pg", "bun"] as const) {
  postgresTest(
    gate,
    `${driver}: validation true batch and rollback`,
    async () => {
      if (driver === "bun" && (typeof Bun === "undefined" || typeof Bun.SQL !== "function")) return;
      await withPostgresSchema(async (sql, schemaName) => {
        for (const statement of renderCatalog(app.catalog, schemaName)) {
          await sql.unsafe(statement);
        }
        const { db, close } = await openDriver(driver, schemaName);
        try {
          await proveBatch(db);
        } finally {
          await close();
        }
      });
    },
    30_000,
  );
}

test("pglite: isolation passes with validation true", async () => {
  const harness = await testing(tenantApp, { driver: openPglitePool() });
  try {
    harness.factories({
      notes: (x) => ({ title: x.words(2) }),
    });
    const report = await harness.isolation();
    expect([...report.checked]).toEqual(["notes"]);
  } finally {
    await harness.close();
  }
}, 30_000);

for (const driver of ["postgresjs", "pg", "bun"] as const) {
  postgresTest(
    gate,
    `${driver}: isolation passes with validation true`,
    async () => {
      if (driver === "bun" && (typeof Bun === "undefined" || typeof Bun.SQL !== "function")) return;
      await withPostgresSchema(async (sql, schemaName) => {
        for (const statement of renderCatalog(tenantApp.catalog, schemaName)) {
          await sql.unsafe(statement);
        }
        const url = primaryUrl();
        const pool =
          driver === "postgresjs"
            ? openPostgres({ url, searchPath: schemaName, max: 1 })
            : driver === "pg"
              ? openPg({ url, searchPath: schemaName, max: 1 })
              : openBun({ url, searchPath: schemaName, max: 1 });
        const harness = await testing(tenantApp, { driver: pool, migrate: false });
        try {
          harness.factories({
            notes: (x) => ({ title: x.words(2) }),
          });
          const report = await harness.isolation();
          expect([...report.checked]).toEqual(["notes"]);
        } finally {
          await harness.close();
        }
      });
    },
    60_000,
  );
}
