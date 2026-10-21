/**
 * `aggregate({ having })` on real Postgres (F8, #509).
 *
 * `having` is the `where` predicate form over `count` and the `select` names.
 * The tests cover NULL aggregates, empty groups and tables, `or()`, text and
 * number operands, a bucket group, tenant isolation, plan reuse across
 * different operands, and every refusal.
 */

import { expect } from "bun:test";

import {
  between,
  bucket,
  contains,
  eq,
  gt,
  gte,
  inList,
  lt,
  not,
  notIn,
  or,
  startsWith,
} from "../src/dialects/pg/index.js";
import { caught, onEveryDriver, seed, type Db } from "./sql-options-fixture.js";

const SELECT = {
  rows: { count: true },
  buyers: { countDistinct: "customer" },
  total: { sum: "amount" },
  mean: { avg: "amount" },
  top: { max: "customer" },
} as const;

onEveryDriver("having keeps the groups whose aggregates match", async (db: Db) => {
  const empty = db.for({ tenantId: "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c99" });
  expect(
    await empty.sales.aggregate({ groupBy: ["region"], having: { count: gte(1) }, limit: 5 }),
  ).toEqual([]);

  const { a, b } = await seed(db);
  const regions = async (having: object): Promise<readonly unknown[]> =>
    (
      await a.sales.aggregate({
        groupBy: ["region"],
        select: SELECT,
        having: having as never,
        orderBy: { region: "asc" },
        limit: 10,
      })
    ).map((row) => row.region);

  // count is there without count: true, and it is not added to the row.
  const counted = await a.sales.aggregate({
    groupBy: ["region"],
    having: { count: gte(2) },
    orderBy: { region: "asc" },
    limit: 10,
  });
  expect(counted).toEqual([{ region: "north" }, { region: "south" }]);
  expect(await regions({ count: 1 })).toEqual(["east"]);
  expect(await regions({ count: between(2, 3) })).toEqual(["south"]);

  // A NULL aggregate never matches a comparison, and null matches only NULL.
  expect(await regions({ total: gt(5) })).toEqual(["north", "south"]);
  expect(await regions({ total: null })).toEqual(["east"]);
  expect(await regions({ total: not(null) })).toEqual(["north", "south"]);
  expect(await regions({ total: lt(100) })).toEqual(["north", "south"]);

  // countDistinct, avg, and text max.
  expect(await regions({ buyers: inList([0, 2]) })).toEqual(["east", "north"]);
  expect(await regions({ buyers: notIn([0, 2]) })).toEqual(["south"]);
  expect(await regions({ mean: gt(11.5) })).toEqual(["north"]);
  expect(await regions({ mean: gt("11.5") })).toEqual(["north"]);
  expect(await regions({ top: gt("c2") })).toEqual(["south"]);
  expect(await regions({ top: eq("c3") })).toEqual(["south"]);
  expect(await regions({ top: startsWith("c") })).toEqual(["north", "south"]);
  expect(await regions({ top: contains("2") })).toEqual(["north"]);

  // Names combine with and; or() joins whole objects.
  expect(await regions({ rows: gte(2), total: gt(10) })).toEqual(["north"]);
  expect(await regions({ rows: gte(2), total: undefined })).toEqual(["north", "south"]);
  expect(await regions(or([{ rows: lt(2) }, { total: gt(30) }]))).toEqual(["east", "north"]);
  expect(await regions(or([]))).toEqual([]);
  expect(await regions({})).toEqual(["east", "north", "south"]);

  // The where runs first. Tenant A's groups do not see tenant B's 1000.
  expect(await regions({ total: gt(100) })).toEqual([]);
  expect(
    await b.sales.aggregate({
      groupBy: ["region"],
      select: { total: { sum: "amount" } },
      having: { total: gt(100) },
      limit: 5,
    }),
  ).toEqual([{ region: "north", total: 1000 }]);
  expect(
    await a.sales.aggregate({
      where: { region: "void" },
      groupBy: ["region"],
      having: { count: gte(0) },
      limit: 5,
    }),
  ).toEqual([]);
});

onEveryDriver("having sits between group by and order by, and with a bucket", async (db: Db) => {
  const { a } = await seed(db);

  const sql = await a.sales
    .aggregate({
      groupBy: ["region"],
      select: { total: { sum: "amount" } },
      having: { count: gte(2), total: gt(5) },
      orderBy: { region: "desc" },
      limit: 5,
    })
    .sql();
  expect(sql.text).toContain(
    'group by t."region" having count(*) >= $2 and sum(t."amount") > $3 order by',
  );

  const perDay = await a.sales.aggregate({
    groupBy: [bucket("seenAt", "day", { tz: "UTC", as: "day" })],
    select: { rows: { count: true } },
    having: { rows: gte(2) },
    orderBy: { day: "asc" },
    limit: 10,
  });
  expect(perDay.map((row) => row.rows)).toEqual([2, 4]);
});

onEveryDriver("having reuses a plan for other operands and keeps names apart", async (db: Db) => {
  const { a } = await seed(db);
  const run = (min: number): Promise<readonly { readonly region: string }[]> =>
    a.sales.aggregate({
      groupBy: ["region"],
      having: { count: gte(min) },
      orderBy: { region: "asc" },
      limit: 10,
    });
  expect((await run(1)).length).toBe(3);
  expect((await run(2)).length).toBe(2);
  expect((await run(3)).length).toBe(1);
  expect((await run(5)).length).toBe(0);

  const sums = (name: "x" | "y"): Promise<readonly unknown[]> =>
    a.sales.aggregate({
      groupBy: ["region"],
      select: { x: { sum: "amount" }, y: { max: "amount" } },
      having: name === "x" ? { x: gt(30) } : { y: gt(6) },
      orderBy: { region: "asc" },
      limit: 10,
    });
  expect(await sums("x")).toEqual([{ region: "north", x: 35, y: 20 }]);
  expect(await sums("y")).toEqual([
    { region: "north", x: 35, y: 20 },
    { region: "south", x: 7, y: 7 },
  ]);
});

onEveryDriver("having refuses what is not an aggregate predicate", async (db: Db) => {
  const { a } = await seed(db);
  const run = (
    having: unknown,
    more: object = { groupBy: ["region"] },
  ): ReturnType<typeof caught> =>
    caught(
      a.sales.aggregate({
        ...more,
        select: { total: { sum: "amount" }, top: { max: "customer" } },
        having: having as never,
        limit: 5,
      } as never),
    );

  const flat = await run({ count: gte(1) }, {});
  expect(flat.code).toBe("OKM1120");
  expect(flat.message).toBe("having needs groupBy.");

  const unknown = await run({ amount: gt(1) });
  expect(unknown.code).toBe("OKM1120");
  expect(unknown.message).toContain("Accepted names: count, total, top");

  // The list forms have no flat name.
  const listed = await caught(
    a.sales.aggregate({
      groupBy: ["region"],
      sum: ["amount"],
      having: { amount: gt(1) } as never,
      limit: 5,
    }),
  );
  expect(listed.message).toContain("Accepted names: count");

  for (const form of [5, [{ count: 1 }], "count", gt(1)]) {
    const bad = await run(form);
    expect(bad.code).toBe("OKM1121");
    expect(bad.message).toBe("having is an object of aggregate names, or or() of such objects.");
  }
  expect((await run(or([5 as never]))).message).toBe("or() branches must be having objects.");
  expect((await run(or([{}]))).message).toBe("An or() branch needs at least one aggregate.");

  const text = await run({ total: contains("1") });
  expect(text.code).toBe("OKM1121");
  expect(text.message).toBe("having total does not take contains.");
  const nested = await run({ total: not(startsWith("1")) });
  expect(nested.message).toBe("having total does not take startsWith.");

  const notNumber = await run({ total: gt("abc") });
  expect(notNumber.code).toBe("OKM1121");
  expect(notNumber.message).toContain("number or a numeric string");
  expect((await run({ total: gt(null) })).code).toBe("OKM1121");
  expect((await run({ total: { a: 1 } })).code).toBe("OKM1121");
});
