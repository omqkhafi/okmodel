/**
 * `aggregate({ countDistinct })` on real Postgres (F8, #506).
 *
 * NULL values are not counted, an all-NULL group counts 0, an empty table
 * gives one row of 0 without `groupBy` and no rows with it, and the tenant
 * predicate applies.
 */

import { expect } from "bun:test";

import { caught, onEveryDriver, seed, type Db } from "./sql-options-fixture.js";

onEveryDriver("countDistinct counts different non-null values per group", async (db: Db) => {
  const empty = db.for({ tenantId: "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c99" });
  expect(await empty.sales.aggregate({ countDistinct: ["customer"], limit: 1 })).toEqual([
    { countDistinct: { customer: 0 } },
  ]);
  expect(
    await empty.sales.aggregate({ groupBy: ["region"], countDistinct: ["customer"], limit: 5 }),
  ).toEqual([]);

  const { a } = await seed(db);

  const byRegion = await a.sales.aggregate({
    groupBy: ["region"],
    count: true,
    countDistinct: ["customer", "channel"],
    orderBy: { region: "asc" },
    limit: 10,
  });
  expect(byRegion).toEqual([
    { region: "east", count: 1, countDistinct: { customer: 0, channel: 0 } },
    { region: "north", count: 4, countDistinct: { customer: 2, channel: 2 } },
    { region: "south", count: 2, countDistinct: { customer: 1, channel: 1 } },
  ]);

  // Without groupBy: one row for the whole table, and tenant B's c9 is not counted.
  expect(await a.sales.aggregate({ countDistinct: ["customer", "region"], limit: 1 })).toEqual([
    { countDistinct: { customer: 3, region: 3 } },
  ]);

  // A where that matches nothing still gives the one total row.
  expect(
    await a.sales.aggregate({
      where: { region: "void" },
      countDistinct: ["customer"],
      limit: 1,
    }),
  ).toEqual([{ countDistinct: { customer: 0 } }]);

  // It sits next to the other functions in one statement.
  const mixed = await a.sales.aggregate({
    where: { region: "north" },
    countDistinct: ["customer"],
    sum: ["amount"],
    max: ["customer"],
    limit: 1,
  });
  expect(mixed).toEqual([
    { countDistinct: { customer: 2 }, sum: { amount: 35 }, max: { customer: "c2" } },
  ]);

  const sql = await a.sales.aggregate({ countDistinct: ["customer"], limit: 1 }).sql();
  expect(sql.text).toContain('count(distinct t."customer")');
  expect(sql.text).toContain('"tenant_id"');
});

onEveryDriver("countDistinct refuses what an aggregate refuses", async (db: Db) => {
  const { a } = await seed(db);
  const hidden = await caught(a.sales.aggregate({ countDistinct: ["secret" as never], limit: 1 }));
  expect(hidden.code).toBe("OKM1120");
  expect(hidden.message).toContain("hidden");

  const unknown = await caught(a.sales.aggregate({ countDistinct: ["nope" as never], limit: 1 }));
  expect(unknown.code).toBe("OKM1120");
  expect(unknown.message).toContain("Accepted names");

  const notList = await caught(a.sales.aggregate({ countDistinct: "customer" as never, limit: 1 }));
  expect(notList.message).toBe("countDistinct must be a list of field names.");
});
