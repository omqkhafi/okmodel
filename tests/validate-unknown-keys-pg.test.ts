/**
 * Unknown write keys under validation (R1).
 *
 * With `validation: true` or `false`, every write path refuses an unknown key
 * with OKM1120 (key + table). No rows change. Covers insert, insert list,
 * update mixed, typo-only update, onConflict update/ignore, first-or-create,
 * tx, and batch on all four adapters.
 */

import { expect, test } from "bun:test";

import { open as openBun } from "../src/adapters/pg/bunsql.js";
import { open as openPg } from "../src/adapters/pg/nodepostgres.js";
import { open as openPglitePool } from "../src/adapters/pg/pglite.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import { OkmError } from "../src/contracts/index.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import { v } from "../src/runtime/validate/index.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

function notesTable(validation: boolean) {
  return table(
    "notes",
    {
      id: id({ default: "none" }),
      title: text().validate([v.trim(), v.min(1, "title_required")]),
    },
    { validation },
  );
}

const appOn = schema({ tables: [notesTable(true)], validation: true });
const appOff = schema({ tables: [notesTable(false)], validation: false });

const gate = await loadPostgresGate();

type Driver = "postgresjs" | "pg" | "bun" | "pglite";
type Mode = "on" | "off";

type Db = {
  readonly connected: Promise<void>;
  notes: {
    insert(
      row: Record<string, unknown> | readonly Record<string, unknown>[],
      options?: {
        readonly onConflict?:
          | "ignore"
          | { readonly on: string; readonly update: readonly string[] }
          | { readonly on: string; readonly return: true };
      },
    ): Promise<unknown>;
    update(
      input:
        | { readonly where: { readonly id: string }; readonly set: Record<string, unknown> }
        | readonly {
            readonly where: { readonly id: string };
            readonly set: Record<string, unknown>;
          }[],
    ): Promise<{ readonly count: number }>;
    one(input: { readonly where: { readonly id: string } }): Promise<{
      readonly id: string;
      readonly title: string;
    } | null>;
    count(): Promise<number>;
  };
  batch(ops: readonly unknown[]): Promise<readonly unknown[]>;
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

async function openDriver(
  driver: Driver,
  mode: Mode,
  schemaName: string | undefined,
): Promise<{ readonly db: Db; readonly close: () => Promise<void> }> {
  const built = mode === "on" ? appOn : appOff;
  if (driver === "pglite") {
    const pool = await openPglitePool();
    for (const statement of renderCatalog(built.catalog, "public")) await pool.execute(statement);
    const db = (await connectPglite(pool, { schema: built })) as unknown as Db;
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
  const options = { schema: built, searchPath: path, max: 1 };
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

async function refused(run: () => Promise<unknown>, key: string): Promise<OkmError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    const failed = error as OkmError;
    expect(failed.code).toBe("OKM1120");
    expect(failed.message).toContain(key);
    expect(failed.message).toContain("notes");
    expect(failed.message).not.toContain("update set is empty");
    return failed;
  }
  throw new Error(`expected OKM1120 for ${key}`);
}

async function proveUnknownKeys(db: Db): Promise<void> {
  await db.connected;

  await refused(() => db.notes.insert({ id: ID_A, title: "a", nope: 5 } as never), "nope");
  expect(await db.notes.count()).toBe(0);

  await refused(
    () =>
      db.notes.insert([
        { id: ID_A, title: "a" },
        { id: ID_B, title: "b", extra: 1 },
      ] as never),
    "extra",
  );
  expect(await db.notes.count()).toBe(0);

  await db.notes.insert({ id: ID_A, title: "kept" });

  await refused(
    () => db.notes.update({ where: { id: ID_A }, set: { title: "b", nope: 5 } as never }),
    "nope",
  );
  expect((await db.notes.one({ where: { id: ID_A } }))?.title).toBe("kept");

  await refused(
    () => db.notes.update({ where: { id: ID_A }, set: { titl: "typo" } as never }),
    "titl",
  );
  expect((await db.notes.one({ where: { id: ID_A } }))?.title).toBe("kept");

  await refused(
    () =>
      db.notes.insert({ id: ID_B, title: "c", nope: 1 } as never, {
        onConflict: { on: "id", update: ["title"] },
      }),
    "nope",
  );
  expect(await db.notes.count()).toBe(1);

  await refused(
    () =>
      db.notes.insert({ id: ID_B, title: "d", nope: true } as never, {
        onConflict: "ignore",
      }),
    "nope",
  );
  expect(await db.notes.count()).toBe(1);

  await refused(
    () =>
      db.notes.insert({ id: ID_B, title: "e", nope: true } as never, {
        onConflict: { on: "id", return: true },
      }),
    "nope",
  );
  expect(await db.notes.count()).toBe(1);

  await refused(
    () =>
      db.tx(async (tx) => {
        await tx.notes.insert({ id: ID_C, title: "tx", nope: 9 } as never);
      }),
    "nope",
  );
  expect(await db.notes.count()).toBe(1);
  expect(await db.notes.one({ where: { id: ID_C } })).toBeNull();

  await refused(
    () =>
      db.batch([
        db.notes.insert({ id: ID_C, title: "batch-ok" }),
        db.notes.update({ where: { id: ID_A }, set: { title: "x", nope: 1 } as never }),
      ]),
    "nope",
  );
  expect(await db.notes.one({ where: { id: ID_C } })).toBeNull();
  expect((await db.notes.one({ where: { id: ID_A } }))?.title).toBe("kept");

  await db.notes.update({ where: { id: ID_A }, set: { title: "ok" } });
  expect((await db.notes.one({ where: { id: ID_A } }))?.title).toBe("ok");
}

for (const mode of ["on", "off"] as const) {
  test(`pglite: validation ${mode} refuses unknown write keys`, async () => {
    const { db, close } = await openDriver("pglite", mode, undefined);
    try {
      await proveUnknownKeys(db);
    } finally {
      await close();
    }
  }, 30_000);

  for (const driver of ["postgresjs", "pg", "bun"] as const) {
    postgresTest(
      gate,
      `${driver}: validation ${mode} refuses unknown write keys`,
      async () => {
        if (driver === "bun" && (typeof Bun === "undefined" || typeof Bun.SQL !== "function")) {
          return;
        }
        const built = mode === "on" ? appOn : appOff;
        await withPostgresSchema(async (sql, schemaName) => {
          for (const statement of renderCatalog(built.catalog, schemaName)) {
            await sql.unsafe(statement);
          }
          const { db, close } = await openDriver(driver, mode, schemaName);
          try {
            await proveUnknownKeys(db);
          } finally {
            await close();
          }
        });
      },
      60_000,
    );
  }
}
