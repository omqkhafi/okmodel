/**
 * `orderBy: { dir, nulls }` on every read that orders, on real Postgres (F8, #510).
 *
 * The shared fixture has three NULL amounts, a NULL customer group, and a
 * group whose `sum` is NULL. Each read is checked for the four combinations of
 * direction and NULL placement, and the plain `asc` and `desc` defaults
 * (`asc` puts NULLs last, `desc` puts them first). `include` is covered in
 * `tests/relations-pg.test.ts`.
 */

import { expect } from "bun:test";

import { bucket, rowNumber } from "../src/dialects/pg/index.js";
import { caught, onEveryDriver, seed, type Db } from "./sql-options-fixture.js";

type Row = { readonly id: string; readonly amount: number | null };
type Order = "asc" | "desc" | { readonly dir: "asc" | "desc"; readonly nulls: "first" | "last" };

const NULL = null;
/** An order, the amounts it gives, and the amount of the first north row under it. */
const ORDERS: readonly (readonly [Order, readonly (number | null)[], number | null])[] = [
  ["asc", [5, 7, 10, 20, NULL, NULL, NULL], 5],
  ["desc", [NULL, NULL, NULL, 20, 10, 7, 5], NULL],
  [{ dir: "asc", nulls: "first" }, [NULL, NULL, NULL, 5, 7, 10, 20], NULL],
  [{ dir: "asc", nulls: "last" }, [5, 7, 10, 20, NULL, NULL, NULL], 5],
  [{ dir: "desc", nulls: "first" }, [NULL, NULL, NULL, 20, 10, 7, 5], NULL],
  [{ dir: "desc", nulls: "last" }, [20, 10, 7, 5, NULL, NULL, NULL], 20],
];

onEveryDriver("find, one, page, and stream place NULLs where nulls says", async (db: Db) => {
  const { a } = await seed(db);
  for (const [order, expected, firstNorth] of ORDERS) {
    const found = await a.sales.find({
      select: ["id", "amount"],
      orderBy: { amount: order },
      limit: 10,
    });
    expect(found.map((row) => row.amount)).toEqual([...expected]);

    const first = await a.sales.one({ orderBy: { amount: order }, where: { region: "north" } });
    expect(first?.amount).toBe(firstNorth);

    // A cursor and a stream walk the same order, across the NULL rows, with no row lost or repeated.
    // Rows that tie keep the primary key order there, so they are compared as a set.
    const everyId = found.map((row) => row.id).sort();
    const paged: Row[] = [];
    let after: string | null = null;
    for (let turn = 0; turn < 10; turn += 1) {
      const page: { readonly items: readonly Row[]; readonly next: string | null } =
        await a.sales.page({ orderBy: { amount: order }, limit: 2, after });
      paged.push(...page.items);
      after = page.next;
      if (after === null) break;
    }
    expect(paged.map((row) => row.amount)).toEqual([...expected]);
    expect(paged.map((row) => row.id).sort()).toEqual(everyId);

    const streamed: Row[] = [];
    for await (const row of a.sales
      .find({ orderBy: { amount: order } })
      .all("nulls order")
      .stream()) {
      streamed.push(row);
    }
    expect(streamed.map((row) => row.amount)).toEqual([...expected]);
    expect(streamed.map((row) => row.id).sort()).toEqual(everyId);
  }

  const bad = await caught(
    a.sales.find({ orderBy: { amount: { dir: "asc", nulls: "middle" as never } }, limit: 1 }),
  );
  expect(bad.code).toBe("OKM1120");
  expect(bad.message).toBe("orderBy amount nulls must be first or last.");
});

onEveryDriver("a window helper orders its partition with nulls", async (db: Db) => {
  const { a } = await seed(db);
  const numbered = async (order: Order): Promise<ReadonlyMap<number | null, number>> => {
    const rows = await a.sales.find({
      where: { region: "north" },
      select: [
        "amount",
        rowNumber({ partitionBy: ["region"], orderBy: { amount: order }, as: "n" }),
      ],
      limit: 10,
    });
    return new Map(rows.map((row) => [row.amount, row.n]));
  };
  expect(await numbered("asc")).toEqual(
    new Map([
      [5, 1],
      [10, 2],
      [20, 3],
      [NULL, 4],
    ]),
  );
  expect(await numbered({ dir: "asc", nulls: "first" })).toEqual(
    new Map([
      [NULL, 1],
      [5, 2],
      [10, 3],
      [20, 4],
    ]),
  );
  expect(await numbered({ dir: "desc", nulls: "last" })).toEqual(
    new Map([
      [20, 1],
      [10, 2],
      [5, 3],
      [NULL, 4],
    ]),
  );
});

onEveryDriver(
  "aggregate orders groups by a key, count, or a select name with nulls",
  async (db: Db) => {
    const { a } = await seed(db);

    // customer: c1 (2 rows), c2 (1), c3 (2), and the NULL group (2 rows).
    const byCustomer = async (order: Order): Promise<readonly (string | null)[]> =>
      (
        await a.sales.aggregate({
          groupBy: ["customer"],
          orderBy: { customer: order },
          limit: 10,
        })
      ).map((row) => row.customer);
    expect(await byCustomer("asc")).toEqual(["c1", "c2", "c3", NULL]);
    expect(await byCustomer("desc")).toEqual([NULL, "c3", "c2", "c1"]);
    expect(await byCustomer({ dir: "asc", nulls: "first" })).toEqual([NULL, "c1", "c2", "c3"]);
    expect(await byCustomer({ dir: "desc", nulls: "last" })).toEqual(["c3", "c2", "c1", NULL]);

    // region: north sums 35, south 7, east is NULL.
    const byTotal = async (order: Order): Promise<readonly string[]> =>
      (
        await a.sales.aggregate({
          groupBy: ["region"],
          select: { total: { sum: "amount" } },
          orderBy: { total: order },
          limit: 10,
        })
      ).map((row) => row.region);
    expect(await byTotal("asc")).toEqual(["south", "north", "east"]);
    expect(await byTotal("desc")).toEqual(["east", "north", "south"]);
    expect(await byTotal({ dir: "asc", nulls: "first" })).toEqual(["east", "south", "north"]);
    expect(await byTotal({ dir: "desc", nulls: "last" })).toEqual(["north", "south", "east"]);

    // count orders without count: true; a key and an aggregate mix, in the order given.
    const byCount = await a.sales.aggregate({
      groupBy: ["region"],
      orderBy: { count: "desc", region: "asc" },
      limit: 10,
    });
    expect(byCount).toEqual([{ region: "north" }, { region: "south" }, { region: "east" }]);

    const mixed = await a.sales.aggregate({
      groupBy: ["channel", "region"],
      select: { biggest: { max: "amount" }, first: { min: "seenAt" } },
      orderBy: { channel: { dir: "asc", nulls: "first" }, biggest: { dir: "desc", nulls: "last" } },
      limit: 10,
    });
    expect(mixed.map((row) => [row.channel, row.region, row.biggest])).toEqual([
      [NULL, "north", 5],
      [NULL, "east", NULL],
      ["app", "north", NULL],
      ["web", "north", 20],
      ["web", "south", 7],
    ]);
    // An aggregate of a timestamp sorts as a timestamp, with NULL groups placed by nulls.
    const earliest = await a.sales.aggregate({
      groupBy: ["region"],
      select: { first: { min: "seenAt" } },
      orderBy: { first: { dir: "asc", nulls: "first" }, region: "asc" },
      limit: 10,
    });
    expect(earliest.map((row) => row.region)).toEqual(["east", "south", "north"]);
    expect(earliest[2]?.first?.toString()).toBe("2026-01-01T00:00:00Z");

    // A bucket group, ordered by its alias and an aggregate.
    const perDay = await a.sales.aggregate({
      groupBy: [bucket("seenAt", "day", { tz: "UTC", as: "day" })],
      select: { rows: { count: true }, total: { sum: "amount" } },
      orderBy: { total: { dir: "desc", nulls: "last" }, day: "asc" },
      limit: 10,
    });
    expect(perDay.map((row) => row.total)).toEqual([30, 12, NULL]);

    const sql = await a.sales
      .aggregate({
        groupBy: ["region"],
        select: { total: { sum: "amount" } },
        orderBy: { total: { dir: "asc", nulls: "first" }, region: "desc" },
        limit: 3,
      })
      .sql();
    expect(sql.text).toContain(
      'group by t."region" order by sum(t."amount") asc nulls first, t."region" desc nulls first',
    );
  },
);

onEveryDriver(
  "aggregate orderBy refuses what is not a key or an aggregate name",
  async (db: Db) => {
    const { a } = await seed(db);
    const run = (orderBy: unknown, more: object = {}): ReturnType<typeof caught> =>
      caught(
        a.sales.aggregate({
          groupBy: ["region"],
          select: { total: { sum: "amount" } },
          sum: ["amount"],
          orderBy: orderBy as never,
          limit: 3,
          ...more,
        }),
      );

    const unknown = await run({ nope: "asc" });
    expect(unknown.code).toBe("OKM1120");
    expect(unknown.message).toContain("Accepted names: region, count, total");

    // The list forms have no flat name, and a table field that is not grouped is not a key.
    expect((await run({ sum: "asc" })).code).toBe("OKM1120");
    expect((await run({ amount: "asc" })).code).toBe("OKM1120");
    expect((await run({ secret: "asc" })).message).toContain("hidden");

    const nulls = await run({ total: { dir: "asc", nulls: "middle" } });
    expect(nulls.message).toBe("orderBy total nulls must be first or last.");
    expect((await run({ total: "up" })).message).toBe("orderBy total must be asc or desc.");
    expect((await run({ total: undefined })).code).toBe("OKM1120");

    // Without groupBy there is one row, so there is nothing to order.
    const flat = await caught(
      a.sales.aggregate({
        select: { total: { sum: "amount" } },
        orderBy: { total: "asc" } as never,
        limit: 1,
      }),
    );
    expect(flat.code).toBe("OKM1120");
  },
);
