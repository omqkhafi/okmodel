/**
 * `aggregate({ select })` on real Postgres (F8, #508).
 *
 * Each entry is one function and gives one flat result key. The tests cover
 * several entries of the same function and column, NULL-only groups, empty
 * tables, the list forms next to named ones, a bucket group, tenant isolation,
 * and every refusal.
 */

import { expect } from "bun:test";

import { bucket } from "../src/dialects/pg/index.js";
import { caught, onEveryDriver, seed, type Db } from "./sql-options-fixture.js";

onEveryDriver("select gives one flat typed key per entry", async (db: Db) => {
  const empty = db.for({ tenantId: "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c99" });
  expect(
    await empty.sales.aggregate({
      select: {
        rows: { count: true },
        total: { sum: "amount" },
        buyers: { countDistinct: "customer" },
      },
      limit: 1,
    }),
  ).toEqual([{ rows: 0, total: null, buyers: 0 }]);
  expect(
    await empty.sales.aggregate({
      groupBy: ["region"],
      select: { rows: { count: true } },
      limit: 5,
    }),
  ).toEqual([]);

  const { a } = await seed(db);

  const byRegion = await a.sales.aggregate({
    groupBy: ["region"],
    select: {
      rows: { count: true },
      buyers: { countDistinct: "customer" },
      total: { sum: "amount" },
      lowest: { min: "amount" },
      highest: { max: "amount" },
      firstCustomer: { min: "customer" },
      cheapest: { min: "amount" },
    },
    orderBy: { region: "asc" },
    limit: 10,
  });
  expect(byRegion).toEqual([
    {
      region: "east",
      rows: 1,
      buyers: 0,
      total: null,
      lowest: null,
      highest: null,
      firstCustomer: null,
      cheapest: null,
    },
    {
      region: "north",
      rows: 4,
      buyers: 2,
      total: 35,
      lowest: 5,
      highest: 20,
      firstCustomer: "c1",
      cheapest: 5,
    },
    {
      region: "south",
      rows: 2,
      buyers: 1,
      total: 7,
      lowest: 7,
      highest: 7,
      firstCustomer: "c3",
      cheapest: 7,
    },
  ]);

  const [mean] = await a.sales.aggregate({
    where: { region: "north" },
    select: { mean: { avg: "amount" } },
    limit: 1,
  });
  expect(mean?.mean).toBeCloseTo(35 / 3, 10);

  // Tenant B's 1000 is not in tenant A's totals.
  expect(await a.sales.aggregate({ select: { everything: { sum: "amount" } }, limit: 1 })).toEqual([
    { everything: 42 },
  ]);
});

onEveryDriver("select sits next to the list forms and a bucket", async (db: Db) => {
  const { a } = await seed(db);

  const mixed = await a.sales.aggregate({
    where: { region: "north" },
    count: true,
    sum: ["amount"],
    select: { buyers: { countDistinct: "customer" }, biggest: { max: "amount" } },
    limit: 1,
  });
  expect(mixed).toEqual([{ count: 4, sum: { amount: 35 }, buyers: 2, biggest: 20 }]);

  const perDay = await a.sales.aggregate({
    groupBy: [bucket("seenAt", "day", { tz: "UTC", as: "day" })],
    select: { rows: { count: true } },
    orderBy: { day: "asc" },
    limit: 10,
  });
  expect(perDay.map((row) => row.rows)).toEqual([1, 2, 4]);
  expect(perDay.map((row) => String(row.day))).toEqual(["2026-01-01", "2026-01-02", "null"]);
});

onEveryDriver("select writes its aggregates and keeps plans apart by name", async (db: Db) => {
  const { a } = await seed(db);

  const sql = await a.sales
    .aggregate({
      select: {
        rows: { count: true },
        total: { sum: "amount" },
        buyers: { countDistinct: "customer" },
      },
      limit: 1,
    })
    .sql();
  expect(sql.text).toContain("count(*)::text");
  expect(sql.text).toContain('sum(t."amount")::text');
  expect(sql.text).toContain('count(distinct t."customer")::text');
  expect(sql.text).toContain('"tenant_id"');

  // Same statement, different names: the cached plan must not hand back the first names.
  const first = await a.sales.aggregate({ select: { x: { sum: "amount" } }, limit: 1 });
  const second = await a.sales.aggregate({ select: { y: { sum: "amount" } }, limit: 1 });
  expect(first).toEqual([{ x: 42 }]);
  expect(second).toEqual([{ y: 42 }]);
});

onEveryDriver("select refuses what cannot be a result key or an aggregate", async (db: Db) => {
  const { a } = await seed(db);
  const run = (select: unknown, groupBy?: readonly string[]): ReturnType<typeof caught> =>
    caught(
      a.sales.aggregate({
        select: select as never,
        ...(groupBy === undefined ? {} : { groupBy: groupBy as never }),
        limit: 1,
      }),
    );

  for (const name of ["region", "count", "countDistinct", "sum", "avg", "min", "max"]) {
    const clash = await run({ [name]: { count: true } }, ["region"]);
    expect(clash.code).toBe("OKM1120");
    expect(clash.message).toContain(`select name ${name} is already a result key`);
  }
  const bucketClash = await caught(
    a.sales.aggregate({
      groupBy: [bucket("seenAt", "day", { tz: "UTC", as: "day" })],
      select: { day: { count: true } },
      limit: 1,
    }),
  );
  expect(bucketClash.message).toContain("select name day is already a result key");

  const proto = await run({ ["__proto__"]: { count: true } });
  expect(proto.message).toContain("prototype key");
  const then = await run(Object.fromEntries([[["th", "en"].join(""), { count: true }]]));
  expect(then.message).toContain("prototype key");

  const two = await run({ both: { sum: "amount", max: "amount" } });
  expect(two.code).toBe("OKM1120");
  expect(two.message).toBe(
    "select both needs exactly one of count, countDistinct, sum, avg, min, or max.",
  );
  expect((await run({ none: {} })).message).toContain("needs exactly one");
  expect((await run({ odd: { total: "amount" } })).message).toContain("needs exactly one");
  expect((await run({ odd: "amount" })).message).toContain("needs exactly one");
  expect((await run({ rows: { count: false } })).message).toBe(
    "select rows: count is true when you want a row count.",
  );
  expect((await run([{ count: true }])).message).toBe(
    "select must be an object of named aggregates.",
  );

  const unknown = await run({ odd: { sum: "nope" } });
  expect(unknown.code).toBe("OKM1120");
  expect(unknown.message).toContain("Accepted names");
  const hidden = await run({ odd: { max: "secret" } });
  expect(hidden.message).toContain("hidden");
  const notNumber = await run({ odd: { sum: "region" } });
  expect(notNumber.code).toBe("OKM1124");
  expect((await run({ odd: { sum: ["amount"] } })).code).toBe("OKM1120");

  const nothing = await caught(a.sales.aggregate({ limit: 1 }));
  expect(nothing.message).toBe(
    "aggregate() needs count, countDistinct, sum, avg, min, max, select, or groupBy.",
  );
});
