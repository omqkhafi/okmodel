/**
 * Object column values are leaves. A where on them filters the matching rows.
 *
 * The timestamp input is Temporal.Instant. A Date is not a codec input (D178).
 */

import { expect } from "bun:test";

import {
  bytea,
  date,
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

postgresTest(
  gate,
  "QA-C1: object field values filter the matching rows",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
      const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
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

        const byInstant = await db.notes.find({ where: { createdAt: AT } as never, limit: 5 });
        expect(byInstant.map((row) => row.id)).toEqual([MATCH]);
        expect(
          await db.notes.find({ where: { createdAt: AT_OTHER } as never, limit: 5 }),
        ).toHaveLength(1);
        expect(await db.notes.count({ where: { day: DAY } as never })).toBe(1);
        expect(await db.notes.count({ where: { day: DAY_OTHER } as never })).toBe(1);
        expect(await db.notes.find({ where: { meta: {} }, limit: 5 })).toHaveLength(1);
        expect(await db.notes.find({ where: { meta: { a: 1 } }, limit: 5 })).toHaveLength(1);
        expect(await db.notes.find({ where: { blob: BYTES } as never, limit: 5 })).toHaveLength(1);
        expect(await db.notes.count()).toBe(2);

        expect(
          await db.notes.update({ where: { createdAt: AT } as never, set: { title: "edited" } }),
        ).toEqual({ count: 1 });
        expect((await db.notes.find({ where: { id: OTHER }, limit: 1 }))[0]?.title).toBe("other");

        expect(await db.notes.archive({ where: { day: DAY } as never })).toMatchObject({
          count: 1,
        });
        expect(await db.notes.count()).toBe(1);
        expect(await db.notes.onlyArchived().count()).toBe(1);
        expect(await db.notes.restore({ where: { blob: BYTES } as never })).toEqual({ count: 1 });
        expect(await db.notes.count()).toBe(2);
        expect(await db.notes.onlyArchived().count()).toBe(0);

        expect(await db.notes.delete({ where: { meta: {} } })).toEqual({ count: 1 });
        expect(await db.notes.count()).toBe(1);
        expect((await db.notes.find({ where: { id: OTHER }, limit: 1 }))[0]?.title).toBe("other");
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);
