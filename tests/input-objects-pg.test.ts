/**
 * Object values on insert, update, and `where`, on real Postgres (P27b).
 *
 * A column takes the objects its codec declares as input: Temporal for the date
 * and time types, any JSON for json and jsonb, arrays for array columns, bytes
 * for bytea, plain shapes for ranges and points. Every other object is OKM1121
 * and no statement is sent.
 */

import { expect } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import {
  between,
  bigint,
  bytea,
  custom,
  date,
  eq,
  gt,
  id,
  inList,
  integer,
  interval,
  jsonb,
  lt,
  point,
  schema,
  t,
  table,
  text,
  time,
  timestamp,
  timestamptz,
  timetz,
  tstzrange,
  uuid,
} from "../src/dialects/pg/index.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { open } from "../src/adapters/pg/postgresjs.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const samples = table("samples", {
  id: id({ default: "uuidv4" }),
  at: timestamptz().nullable(),
  local: timestamp().nullable(),
  day: date().nullable(),
  tod: time().nullable(),
  tz: timetz().nullable(),
  every: interval().nullable(),
  meta: jsonb().nullable(),
  doc: t.json().nullable(),
  tags: text().array().nullable(),
  grid: integer().array({ dims: 2 }).nullable(),
  big: bigint({ as: "bigint" }).nullable(),
  blob: bytea().nullable(),
  span: tstzrange().nullable(),
  pt: point().nullable(),
  n: integer().nullable(),
  label: text().nullable(),
  ref: uuid().nullable(),
  // a custom codec names the objects it takes, or takes none
  cash: custom<{ readonly cents: number }>({
    sqlType: "text",
    encode: (value) => String(value.cents),
    decode: (wire) => ({ cents: Number(wire) }),
    accepts: ["Object"],
  }).nullable(),
  slug: custom<string>({
    sqlType: "text",
    encode: (value) => value,
    decode: (wire) => wire,
  }).nullable(),
});

const app = schema({ casing: "snake", tables: [samples] });

const T = globalThis.Temporal;
const NOON = T.Instant.from("2020-01-02T12:00:00.123456Z");
const LATER = T.Instant.from("2021-06-07T08:09:10Z");
const REF = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c8d";

const gate = await loadPostgresGate();

/** Wraps a pool so a test can count the statements that reach the driver. */
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

async function total(
  sql: Parameters<Parameters<typeof withPostgresSchema>[0]>[0],
  from: string,
): Promise<number> {
  const rows = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${from}`);
  return rows[0]?.n ?? -1;
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

async function withSamples(
  run: (
    db: ReturnType<typeof connect<typeof app>>,
    sql: Parameters<Parameters<typeof withPostgresSchema>[0]>[0],
    sent: () => number,
  ) => Promise<void>,
): Promise<void> {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
    const raw = open({ url: primaryUrl(), searchPath: schemaName });
    const spy = counted(raw);
    const db = connect(spy.pool, { schema: app });
    try {
      await run(db, sql, () => spy.sent());
    } finally {
      await db.close();
      await raw.close();
    }
  });
}

postgresTest(
  gate,
  "the default timestamp codec takes Temporal and a Date is refused",
  async () => {
    await withSamples(async (db, sql, sent) => {
      const row = await db.samples.insert(
        {
          at: NOON,
          local: T.PlainDateTime.from("2020-01-02T03:04:05.5"),
          day: T.PlainDate.from("2020-02-29"),
          tod: T.PlainTime.from("23:59:58"),
          tz: { time: T.PlainTime.from("01:02:03"), offset: "+03:00" },
          every: T.Duration.from("PT1H30M"),
        },
        { returning: ["at", "local", "day", "tod"] },
      );
      expect(row.at?.toString()).toBe("2020-01-02T12:00:00.123456Z");
      expect(row.local?.toString()).toBe("2020-01-02T03:04:05.5");
      expect(row.day?.toString()).toBe("2020-02-29");
      expect(row.tod?.toString()).toBe("23:59:58");
      const stored = await sql<{ tz: string; secs: string }[]>`
        select tz::text as tz, extract(epoch from every)::int::text as secs from samples
      `;
      expect(stored[0]).toEqual({ tz: "01:02:03+03", secs: "5400" });

      // update set takes the same types
      const moved = await db.samples.update({
        where: { at: eq(NOON) },
        set: {
          at: LATER,
          local: T.PlainDateTime.from("2022-01-01T00:00:00"),
          day: T.PlainDate.from("2022-01-02"),
          tod: T.PlainTime.from("00:00:01"),
          every: T.Duration.from("P2D"),
        },
      });
      expect(moved).toEqual({ count: 1 });
      const after = await db.samples.find({ where: { at: eq(LATER) }, limit: 5, select: ["day"] });
      expect(after.map((r) => r.day?.toString())).toEqual(["2022-01-02"]);

      // where takes Temporal through eq and the comparison operators
      const here = { limit: 5, select: ["n"] } as const;
      expect(await db.samples.find({ where: { at: eq(LATER) }, ...here })).toHaveLength(1);
      expect(await db.samples.find({ where: { at: eq(NOON) }, ...here })).toHaveLength(0);
      expect(await db.samples.find({ where: { at: lt(NOON) }, ...here })).toHaveLength(0);
      expect(await db.samples.find({ where: { at: gt(NOON) }, ...here })).toHaveLength(1);
      expect(await db.samples.find({ where: { at: between(NOON, LATER) }, ...here })).toHaveLength(
        1,
      );
      expect(await db.samples.find({ where: { at: inList([NOON, LATER]) }, ...here })).toHaveLength(
        1,
      );
      expect(
        await db.samples.find({ where: { day: eq(T.PlainDate.from("2022-01-02")) }, ...here }),
      ).toHaveLength(1);
      expect(
        await db.samples.find({ where: { tod: eq(T.PlainTime.from("00:00:01")) }, ...here }),
      ).toHaveLength(1);
      expect(await db.samples.count({ where: { at: eq(LATER) } })).toBe(1);
      expect(await db.samples.delete({ where: { at: eq(LATER) } })).toEqual({ count: 1 });

      // Date is not an input of any default codec: refused, nothing sent
      const before = sent();
      const wrong: readonly (() => Promise<unknown>)[] = [
        () => db.samples.insert({ at: new Date() as never }),
        () => db.samples.insert({ at: T.PlainDate.from("2020-01-01") as never }),
        () => db.samples.insert({ day: NOON as never }),
        () => db.samples.insert({ every: NOON as never }),
        () => db.samples.update({ where: { n: 1 }, set: { at: new Date() as never } }),
        () => db.samples.find({ where: { at: eq(new Date() as never) }, limit: 1 }),
        // a bare object in a where is refused for every column, Temporal included
        () => db.samples.find({ where: { at: LATER as never }, limit: 1 }),
        () => db.samples.update({ where: { at: NOON as never }, set: { n: 1 } }),
        () => db.samples.count({ where: { day: T.PlainDate.from("2022-01-02") as never } }),
        () => db.samples.find({ where: { at: lt(new Date() as never) }, limit: 1 }),
        () => db.samples.find({ where: { at: inList([NOON, new Date() as never]) }, limit: 1 }),
      ];
      for (const run of wrong) expect(await code(run)).toBe("OKM1121");
      // timetz takes a plain object; a wrong shape is the codec's OKM1210
      expect(await code(() => db.samples.insert({ tz: { gt: 1 } as never }))).toBe("OKM1210");
      expect(sent()).toBe(before);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "json, arrays, bigint, bytes, ranges, and points take their declared input",
  async () => {
    await withSamples(async (db, sql, sent) => {
      const doc = { a: 1, nested: { list: [1, "two", null, true] } };
      const big = 9_007_199_254_740_993n;
      const row = await db.samples.insert(
        {
          meta: doc,
          doc: [1, 2, { x: 3 }],
          tags: ["a", "b,c", 'd"e'],
          grid: [
            [1, 2],
            [3, 4],
          ],
          big,
          blob: new Uint8Array([0, 1, 254, 255]),
          span: {
            empty: false,
            lower: NOON,
            upper: LATER,
            lowerInclusive: true,
            upperInclusive: false,
          },
          pt: { x: 1.5, y: -2 },
        },
        { returning: ["meta", "doc", "tags", "grid", "big", "blob", "span", "pt"] },
      );
      expect(row.meta).toEqual(doc);
      expect(row.doc).toEqual([1, 2, { x: 3 }]);
      expect(row.tags).toEqual(["a", "b,c", 'd"e']);
      expect(row.grid).toEqual([
        [1, 2],
        [3, 4],
      ]);
      expect(row.big).toBe(big);
      expect([...(row.blob ?? [])]).toEqual([0, 1, 254, 255]);
      expect(row.pt).toEqual({ x: 1.5, y: -2 });
      expect(row.span).toMatchObject({ empty: false, lower: NOON, upper: LATER });

      // custom codecs: the declared object is taken, any other is refused
      const paid = await db.samples.insert(
        { cash: { cents: 250 }, slug: "s" },
        { returning: ["cash"] },
      );
      expect(paid.cash).toEqual({ cents: 250 });
      expect(await code(() => db.samples.insert({ cash: [1] as never }))).toBe("OKM1121");
      expect(await code(() => db.samples.insert({ slug: { cents: 1 } as never }))).toBe("OKM1121");
      await db.samples.delete({ where: { slug: "s" } });

      // update set
      await db.samples.update({
        where: { big },
        set: { meta: { replaced: true }, tags: ["z"], big: big + 1n, pt: { x: 0, y: 0 } },
      });
      const next = await db.samples.find({ where: { big: big + 1n }, limit: 5 });
      expect(next.map((r) => r.meta)).toEqual([{ replaced: true }]);
      expect(next.map((r) => r.tags)).toEqual([["z"]]);

      // where equality: bigint bare, arrays, jsonb, and ranges through eq
      const here = { limit: 5, select: ["n"] } as const;
      expect(await db.samples.find({ where: { tags: eq(["z"]) }, ...here })).toHaveLength(1);
      expect(await db.samples.find({ where: { tags: eq(["y"]) }, ...here })).toHaveLength(0);
      expect(
        await db.samples.find({ where: { meta: eq({ replaced: true }) }, ...here }),
      ).toHaveLength(1);
      expect(await db.samples.find({ where: { meta: eq({ replaced: 1 }) }, ...here })).toHaveLength(
        0,
      );
      expect(
        await db.samples.find({
          where: {
            span: eq({
              empty: false,
              lower: NOON,
              upper: LATER,
              lowerInclusive: true,
              upperInclusive: false,
            }),
          },
          ...here,
        }),
      ).toHaveLength(1);
      expect(await total(sql, "samples")).toBe(1);

      // a bare object in a where stays refused (D125), arrays included
      const before = sent();
      const bare: readonly (() => Promise<unknown>)[] = [
        () => db.samples.find({ where: { meta: { replaced: true } as never }, limit: 1 }),
        () => db.samples.find({ where: { meta: [1] as never }, limit: 1 }),
        () => db.samples.find({ where: { span: { empty: true } as never }, limit: 1 }),
        () => db.samples.find({ where: { pt: { x: 0, y: 0 } as never }, limit: 1 }),
        () => db.samples.find({ where: { tags: ["z"] as never }, limit: 1 }),
        () => db.samples.find({ where: { tags: { gt: ["a"] } as never }, limit: 1 }),
      ];
      for (const run of bare) expect(await code(run)).toBe("OKM1121");
      expect(sent()).toBe(before);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "an object into a scalar column is OKM1121 and sends nothing",
  async () => {
    await withSamples(async (db, sql, sent) => {
      await db.samples.insert({ n: 1, label: "keep", ref: REF });
      const before = sent();
      const looksLikeOperator = { gt: 1 } as never;
      const scalar: readonly (() => Promise<unknown>)[] = [
        // insert: integer, text, uuid, bigint, bytea, json-looking input on scalar columns
        () => db.samples.insert({ n: looksLikeOperator }),
        () => db.samples.insert({ n: { not: 1 } as never }),
        () => db.samples.insert({ n: [1] as never }),
        () => db.samples.insert({ label: {} as never }),
        () => db.samples.insert({ label: { contains: "x" } as never }),
        () => db.samples.insert({ label: ["x"] as never }),
        () => db.samples.insert({ ref: { eq: REF } as never }),
        () => db.samples.insert({ big: {} as never }),
        () => db.samples.insert({ blob: {} as never }),
        () => db.samples.insert({ tags: { a: 1 } as never }),
        () => db.samples.insert([{ n: 2 }, { n: looksLikeOperator }]),
        // update set
        () => db.samples.update({ where: { n: 1 }, set: { n: looksLikeOperator } }),
        () => db.samples.update({ where: { n: 1 }, set: { label: { a: 1 } as never } }),
        () => db.samples.update({ where: { n: 1 }, set: { ref: {} as never } }),
        () => db.samples.update({ where: { n: 1 }, set: { tags: { push: "x" } as never } }),
        () => db.samples.update([{ where: { n: 1 }, set: { n: looksLikeOperator } }]),
        // update and find where equality, bare and through eq
        () => db.samples.update({ where: { n: looksLikeOperator }, set: { label: "x" } }),
        () => db.samples.update({ where: { label: { a: 1 } as never }, set: { n: 2 } }),
        () => db.samples.delete({ where: { ref: { eq: REF } as never } }),
        () => db.samples.find({ where: { n: looksLikeOperator }, limit: 1 }),
        () => db.samples.find({ where: { n: eq(looksLikeOperator) }, limit: 1 }),
        () => db.samples.find({ where: { label: {} as never }, limit: 1 }),
        () => db.samples.find({ where: { ref: eq({} as never) }, limit: 1 }),
        () => db.samples.find({ where: { n: lt({} as never) }, limit: 1 }),
        () => db.samples.find({ where: { n: between(1, {} as never) }, limit: 1 }),
        () => db.samples.find({ where: { n: inList([1, {} as never]) }, limit: 1 }),
        () => db.samples.count({ where: { n: looksLikeOperator } }),
      ];
      for (const run of scalar) expect(await code(run)).toBe("OKM1121");
      // range and point take a plain object; an operator-looking one fails their codec
      const shaped: readonly (() => Promise<unknown>)[] = [
        () => db.samples.insert({ span: looksLikeOperator }),
        () => db.samples.insert({ pt: looksLikeOperator }),
        () => db.samples.update({ where: { n: 1 }, set: { span: looksLikeOperator } }),
      ];
      for (const run of shaped) expect(await code(run)).toBe("OKM1210");
      expect(sent()).toBe(before);
      expect(await total(sql, "samples")).toBe(1);
      expect(await db.samples.find({ where: { n: 1 }, limit: 5, select: ["label"] })).toEqual([
        { label: "keep" },
      ]);
    });
  },
  30_000,
);
