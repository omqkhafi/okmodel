/**
 * Object column values are leaves. Equality goes through `eq` (D125).
 *
 * A bare object is OKM1121 and sends no statement. The timestamp input is
 * Temporal.Instant. A Date is not a codec input (D178).
 */

import { expect } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import {
  bytea,
  date,
  eq,
  id,
  jsonb,
  schema,
  table,
  text,
  timestamptz,
} from "../src/dialects/pg/index.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { archivable } from "../src/runtime/traits/index.js";

const MATCH = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c31";
const OTHER = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c32";

const AT = Temporal.Instant.from("2020-01-02T03:04:05Z");
const AT_OTHER = Temporal.Instant.from("2021-06-07T08:09:10Z");
const DAY = Temporal.PlainDate.from("2020-02-29");
const DAY_OTHER = Temporal.PlainDate.from("2021-03-01");
const BYTES = new Uint8Array([1, 2, 3, 4]);
const BYTES_OTHER = new Uint8Array([9, 9]);

const notes = table(
  "notes",
  {
    id: id({ default: "none" }),
    title: text(),
    createdAt: timestamptz(),
    day: date(),
    blob: bytea(),
    meta: jsonb(),
  },
  { traits: [archivable()] },
);

const app = schema({ casing: "snake", tables: [notes] });

const gate = await loadPostgresGate();

function counted(pool: DriverPool): { readonly pool: DriverPool; sent(): number } {
  let sent = 0;
  return {
    pool: {
      ...pool,
      execute: (...args) => {
        sent += 1;
        return pool.execute(...args);
      },
      batch: (...args) => {
        sent += 1;
        return pool.batch(...args);
      },
    },
    sent: () => sent,
  };
}

async function code(pending: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await pending();
  } catch (error) {
    if (error instanceof OkmError) return error.code;
    throw error;
  }
  return undefined;
}

postgresTest(
  gate,
  "QA-C1: eq object values filter the matching rows",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      const raw = open({ url: primaryUrl(), searchPath: schemaName });
      const spy = counted(raw);
      const db = connect(spy.pool, { schema: app });
      try {
        await db.connected;
        await db.notes.insert({
          id: MATCH,
          title: "match",
          createdAt: AT,
          day: DAY,
          blob: BYTES,
          meta: {},
        });
        await db.notes.insert({
          id: OTHER,
          title: "other",
          createdAt: AT_OTHER,
          day: DAY_OTHER,
          blob: BYTES_OTHER,
          meta: { a: 1 },
        });

        const byInstant = await db.notes.find({ where: { createdAt: eq(AT) }, limit: 5 });
        expect(byInstant.map((row) => row.id)).toEqual([MATCH]);
        expect(await db.notes.find({ where: { createdAt: eq(AT_OTHER) }, limit: 5 })).toHaveLength(
          1,
        );
        expect(await db.notes.count({ where: { day: eq(DAY) } })).toBe(1);
        expect(await db.notes.count({ where: { day: eq(DAY_OTHER) } })).toBe(1);
        expect(await db.notes.find({ where: { meta: eq({}) }, limit: 5 })).toHaveLength(1);
        expect(await db.notes.find({ where: { meta: eq({ a: 1 }) }, limit: 5 })).toHaveLength(1);
        expect(await db.notes.find({ where: { blob: eq(BYTES) }, limit: 5 })).toHaveLength(1);
        expect(await db.notes.count()).toBe(2);

        expect(
          await db.notes.update({ where: { createdAt: eq(AT) }, set: { title: "edited" } }),
        ).toEqual({ count: 1 });
        expect((await db.notes.find({ where: { id: OTHER }, limit: 1 }))[0]?.title).toBe("other");

        expect(await db.notes.archive({ where: { day: eq(DAY) } })).toMatchObject({ count: 1 });
        expect(await db.notes.count()).toBe(1);
        expect(await db.notes.onlyArchived().count()).toBe(1);
        expect(await db.notes.restore({ where: { blob: eq(BYTES) } })).toEqual({ count: 1 });
        expect(await db.notes.count()).toBe(2);
        expect(await db.notes.onlyArchived().count()).toBe(0);

        expect(await db.notes.delete({ where: { meta: eq({}) } })).toEqual({ count: 1 });
        expect(await db.notes.count()).toBe(1);
        expect((await db.notes.find({ where: { id: OTHER }, limit: 1 }))[0]?.title).toBe("other");

        const before = spy.sent();
        const bare: readonly (() => Promise<unknown>)[] = [
          () => db.notes.find({ where: { createdAt: AT } as never, limit: 1 }),
          () => db.notes.count({ where: { day: DAY } as never }),
          () => db.notes.find({ where: { blob: BYTES } as never, limit: 1 }),
          () => db.notes.find({ where: { meta: {} }, limit: 1 }),
          () => db.notes.find({ where: { meta: { a: 1 } }, limit: 1 }),
          () => db.notes.update({ where: { createdAt: AT } as never, set: { title: "no" } }),
          () => db.notes.archive({ where: { day: DAY } as never }),
          () => db.notes.restore({ where: { blob: BYTES } as never }),
          () => db.notes.delete({ where: { meta: {} } }),
        ];
        for (const run of bare) expect(await code(run)).toBe("OKM1121");
        expect(spy.sent()).toBe(before);
        expect(await db.notes.count()).toBe(1);
      } finally {
        await db.close();
        await raw.close();
      }
    });
  },
  60_000,
);
