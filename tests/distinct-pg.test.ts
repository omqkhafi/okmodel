/**
 * `find({ distinct })` and `find({ distinctOn })` on real Postgres (F8, #507).
 *
 * NULL is one value for both, an empty match gives no rows, the tenant
 * predicate applies, and every misuse is refused before SQL.
 */

import { expect } from "bun:test";

import { caught, onEveryDriver, seed, type Db } from "./sql-options-fixture.js";

onEveryDriver("distinct keeps one row per combination, NULL included", async (db: Db) => {
  const empty = db.for({ tenantId: "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c99" });
  expect(await empty.sales.find({ distinct: true, select: ["region"], limit: 5 })).toEqual([]);

  const { a } = await seed(db);

  expect(
    await a.sales.find({
      distinct: true,
      select: ["region"],
      orderBy: { region: "asc" },
      limit: 10,
    }),
  ).toEqual([{ region: "east" }, { region: "north" }, { region: "south" }]);

  // NULL is one value, and the default for asc is nulls last.
  const pairs = await a.sales.find({
    distinct: true,
    select: ["region", "channel"],
    orderBy: { region: "asc", channel: "asc" },
    limit: 10,
  });
  expect(pairs).toEqual([
    { region: "east", channel: null },
    { region: "north", channel: "app" },
    { region: "north", channel: "web" },
    { region: "north", channel: null },
    { region: "south", channel: "web" },
  ]);

  // desc is nulls first, and nulls can be set.
  const channels = (orderBy: object): Promise<readonly (string | null)[]> =>
    a.sales
      .find({ distinct: true, select: ["channel"], orderBy: orderBy as never, limit: 10 })
      .then((rows) => rows.map((row) => row.channel));
  expect(await channels({ channel: "desc" })).toEqual([null, "web", "app"]);
  expect(await channels({ channel: { dir: "desc", nulls: "last" } })).toEqual(["web", "app", null]);

  // A timestamp is selected as text, and its order still follows the instant.
  const seen = await a.sales.find({
    distinct: true,
    select: ["seenAt"],
    orderBy: { seenAt: { dir: "desc", nulls: "last" } },
    limit: 10,
  });
  expect(seen.map((row) => row.seenAt?.toString() ?? null)).toEqual([
    "2026-01-02T00:00:00Z",
    "2026-01-01T00:00:00Z",
    null,
  ]);

  // limit and offset apply after the distinct rows.
  expect(
    await a.sales.find({
      distinct: true,
      select: ["region"],
      orderBy: { region: "asc" },
      limit: 1,
      offset: 1,
    }),
  ).toEqual([{ region: "north" }]);

  // where, and the tenant predicate: tenant B's c9 never shows.
  const customers = await a.sales.find({
    distinct: true,
    where: { region: "north" },
    select: ["customer"],
    orderBy: { customer: "asc" },
    limit: 10,
  });
  expect(customers).toEqual([{ customer: "c1" }, { customer: "c2" }, { customer: null }]);
  expect(
    await a.sales.find({ distinct: true, where: { region: "void" }, select: ["region"], limit: 5 }),
  ).toEqual([]);

  const all = await a.sales.find({ distinct: true, select: ["region"] }).all("test");
  expect(all).toHaveLength(3);
  const sql = await a.sales.find({ distinct: true, select: ["region"], limit: 1 }).sql();
  expect(sql.text).toContain("select distinct t.");
  expect(sql.text).toContain('"tenant_id"');
});

onEveryDriver("distinctOn keeps the first row of each key under orderBy", async (db: Db) => {
  const { a } = await seed(db);

  // The largest amount per customer. NULL customer is one key.
  const best = await a.sales.find({
    distinctOn: ["customer"],
    orderBy: { customer: "asc", amount: { dir: "desc", nulls: "last" } },
    select: ["customer", "amount"],
    limit: 10,
  });
  expect(best).toEqual([
    { customer: "c1", amount: 20 },
    { customer: "c2", amount: null },
    { customer: "c3", amount: 7 },
    { customer: null, amount: 5 },
  ]);

  // The same keys with nulls first keep the NULL amount for c3 and for the NULL customer.
  const nullFirst = await a.sales.find({
    distinctOn: ["customer"],
    orderBy: { customer: "asc", amount: { dir: "desc", nulls: "first" } },
    select: ["customer", "amount"],
    limit: 10,
  });
  expect(nullFirst.map((row) => row.amount)).toEqual([20, null, null, null]);

  // Two keys, either order, whole rows without select, and a timestamp key.
  const two = await a.sales.find({
    distinctOn: ["channel", "region"],
    orderBy: { region: "asc", channel: "asc", amount: "asc" },
    select: ["region", "channel", "amount"],
    limit: 10,
  });
  expect(two).toEqual([
    { region: "east", channel: null, amount: null },
    { region: "north", channel: "app", amount: null },
    { region: "north", channel: "web", amount: 10 },
    { region: "north", channel: null, amount: 5 },
    { region: "south", channel: "web", amount: 7 },
  ]);
  const whole = await a.sales.find({
    distinctOn: ["region"],
    orderBy: { region: "asc", amount: { dir: "desc", nulls: "last" } },
    limit: 10,
  });
  expect(whole.map((row) => [row.region, row.amount])).toEqual([
    ["east", null],
    ["north", 20],
    ["south", 7],
  ]);
  expect("secret" in (whole[0] ?? {})).toBe(false);
  const stamped = await a.sales.find({
    distinctOn: ["seenAt"],
    orderBy: { seenAt: { dir: "desc", nulls: "last" }, amount: { dir: "desc", nulls: "last" } },
    select: ["seenAt", "amount"],
    limit: 10,
  });
  expect(stamped.map((row) => [row.seenAt?.toString() ?? null, row.amount])).toEqual([
    ["2026-01-02T00:00:00Z", 20],
    ["2026-01-01T00:00:00Z", null],
    [null, 7],
  ]);

  expect(
    await a.sales.find({
      distinctOn: ["region"],
      where: { region: "void" },
      orderBy: { region: "asc" },
      limit: 5,
    }),
  ).toEqual([]);

  const sql = await a.sales
    .find({ distinctOn: ["region"], orderBy: { region: "asc" }, limit: 1 })
    .sql();
  expect(sql.text).toContain('select distinct on (t."region") ');
});

onEveryDriver("distinct and distinctOn refuse what they cannot keep", async (db: Db) => {
  const { a } = await seed(db);
  const refused = async (options: object, message: string, code = "OKM1120"): Promise<void> => {
    const error = await caught(a.sales.find({ limit: 5, ...options } as never));
    expect(error.code).toBe(code);
    expect(error.message).toContain(message);
  };
  await refused({ distinct: true }, "distinct needs select");
  await refused({ distinct: true, select: [] }, "distinct needs select");
  await refused({ distinct: false, select: ["region"] }, "distinct is true");
  await refused(
    { distinct: true, select: ["region"], orderBy: { amount: "asc" } },
    "distinct orders by a selected field. amount is not in select",
  );
  await refused({ distinct: true, distinctOn: ["region"] }, "distinct or distinctOn, not both");
  await refused({ distinct: true, select: ["region"], include: { x: true } }, "include or search");
  await refused({ distinct: true, select: ["region"], search: "x" }, "include or search");
  await refused({ distinctOn: [] }, "distinctOn must be a list");
  await refused({ distinctOn: "region" }, "distinctOn must be a list");
  await refused({ distinctOn: ["region"] }, "distinctOn needs an orderBy that starts with region");
  await refused(
    { distinctOn: ["region"], orderBy: { amount: "asc", region: "asc" } },
    "starts with region",
  );
  await refused(
    { distinctOn: ["region", "channel"], orderBy: { region: "asc" } },
    "starts with region, channel",
  );
  await refused({ distinctOn: ["region", "region"], orderBy: { region: "asc" } }, "twice");
  await refused({ distinctOn: ["nope"], orderBy: { region: "asc" } }, "Accepted names");
  await refused({ distinctOn: ["secret"], orderBy: { secret: "asc" } }, "secret");

  // Only find takes them: one, page, and count name the accepted options.
  const one = await caught(a.sales.one({ distinct: true } as never));
  expect(one.code).toBe("OKM1120");
  expect(one.message).toContain("distinct");
  const page = await caught(
    a.sales.page({ distinctOn: ["region"], orderBy: { region: "asc" }, limit: 2 } as never),
  );
  expect(page.code).toBe("OKM1120");

  // No limit and no .all() is still OKM1101.
  const unbounded = await caught(a.sales.find({ distinct: true, select: ["region"] } as never));
  expect(unbounded.code).toBe("OKM1101");
});
