/**
 * Relations through a join table, cursor pages, aggregates, and the small
 * semantics of spec section 12, on real Postgres.
 *
 * Two tenants share ids. Labels, tasks, and join rows are archivable.
 */

import { expect } from "bun:test";
import fc from "fast-check";

import { OkmError } from "../src/contracts/error.js";
import {
  contains,
  endsWith,
  every,
  has,
  inList,
  none,
  notIn,
  startsWith,
} from "../src/dialects/pg/index.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { app, TENANT_A, TENANT_B } from "./relations-schema.js";

const gate = await loadPostgresGate();

type Db = ReturnType<typeof connect<typeof app>>;

async function withApp(
  run: (
    db: Db,
    sql: Parameters<Parameters<typeof withPostgresSchema>[0]>[0],
    schemaName: string,
  ) => Promise<void>,
): Promise<void> {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) {
      await sql.unsafe(statement);
    }
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
    try {
      await db.connected;
      await run(db, sql, schemaName);
    } finally {
      await db.close();
    }
  });
}

async function catchError(pending: PromiseLike<unknown>): Promise<OkmError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}

type Uuid = ReturnType<typeof crypto.randomUUID>;

/** A full task row. Array inserts list every key. */
const task = (
  title: string,
  extra: {
    readonly id?: Uuid;
    readonly score?: number | null;
    readonly team?: string | null;
  } = {},
) => ({
  id: extra.id ?? crypto.randomUUID(),
  title,
  score: extra.score ?? null,
  due: null,
  team: extra.team ?? null,
});

const ids = (rows: readonly { readonly id: string }[]): string[] =>
  rows.map((row) => row.id).sort();

const [L1, L2, L3] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()] as const;
const [T1, T2, T3] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()] as const;

postgresTest(
  gate,
  "manyThrough reads through the join table and keeps tenancy and the active set",
  async () => {
    await withApp(async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      await a.labels.insert([
        { id: L1, name: "urgent" },
        { id: L2, name: "home" },
        { id: L3, name: "old" },
      ]);
      await a.tasks.insert([
        task("one", { id: T1 }),
        task("two", { id: T2 }),
        task("three", { id: T3 }),
      ]);
      await a.taskLabels.insert([
        { id: crypto.randomUUID(), taskId: T1, labelId: L1 },
        { id: crypto.randomUUID(), taskId: T1, labelId: L2 },
        { id: crypto.randomUUID(), taskId: T1, labelId: L3 },
        { id: crypto.randomUUID(), taskId: T2, labelId: L2 },
      ]);
      // Tenant B reuses the same ids with its own names and its own join rows.
      await b.labels.insert([{ id: L1, name: "b-urgent" }]);
      await b.tasks.insert([task("b-one", { id: T1 })]);
      await b.taskLabels.insert([{ id: crypto.randomUUID(), taskId: T1, labelId: L1 }]);

      const names = (rows: readonly { readonly name: string }[] | undefined): string[] =>
        (rows ?? []).map((row) => row.name);
      const include = { labels: { limit: 10, orderBy: { name: "asc" } } } as const;
      const first = await a.tasks.find({ where: { id: T1 }, include, limit: 1 });
      expect(names(first[0]?.labels)).toEqual(["home", "old", "urgent"]);
      const other = await b.tasks.find({ where: { id: T1 }, include, limit: 1 });
      expect(names(other[0]?.labels)).toEqual(["b-urgent"]);

      expect(
        ids(await a.tasks.find({ where: { labels: has({ name: "urgent" }) }, limit: 10 })),
      ).toEqual([T1]);
      expect(
        ids(await a.tasks.find({ where: { labels: none({ name: "urgent" }) }, limit: 10 })),
      ).toEqual([T2, T3].sort());
      expect(
        ids(await a.tasks.find({ where: { labels: every({ name: "home" }) }, limit: 10 })),
      ).toEqual([T2, T3].sort());
      expect(
        ids(await a.labels.find({ where: { tasks: has({ title: "one" }) }, limit: 10 })),
      ).toEqual([L1, L2, L3].sort());
      expect(
        ids(await a.labels.find({ where: { tasks: has({ title: "two" }) }, limit: 10 })),
      ).toEqual([L2]);
      expect(
        ids(await b.labels.find({ where: { tasks: has({ title: "two" }) }, limit: 10 })),
      ).toEqual([]);

      const planned = await a.tasks
        .find({ where: { labels: has({ name: "urgent" }) }, include, limit: 5 })
        .sql();
      expect(planned.text).toContain('"task_labels"');
      expect(planned.text).toContain('jr0_labels."tenant_id" = ');
      expect(planned.text).toContain('jr0_labels."archived_at" is null');
      expect(planned.text).toContain('r0_labels."archived_at" is null');
      expect(planned.text.includes(TENANT_A)).toBe(false);

      // An archived target never shows.
      await a.labels.archive({ where: { id: L3 } });
      const noOld = await a.tasks.find({ where: { id: T1 }, include, limit: 1 });
      expect(names(noOld[0]?.labels)).toEqual(["home", "urgent"]);
      expect(await a.tasks.find({ where: { labels: has({ name: "old" }) }, limit: 10 })).toEqual(
        [],
      );
      // An archived join row never shows either.
      await a.taskLabels.archive({ where: { taskId: T1, labelId: L2 } });
      const noHome = await a.tasks.find({ where: { id: T1 }, include, limit: 1 });
      expect(names(noHome[0]?.labels)).toEqual(["urgent"]);
      expect(
        ids(await a.tasks.find({ where: { labels: has({ name: "home" }) }, limit: 10 })),
      ).toEqual([T2]);
      // The wide view shows both.
      const wide = await a.tasks.withArchived().find({ where: { id: T1 }, include, limit: 1 });
      expect(names(wide[0]?.labels)).toEqual(["home", "old", "urgent"]);
      // A filter in a write reaches the same planner.
      expect(
        await a.tasks.update({ where: { labels: has({ name: "urgent" }) }, set: { team: "x" } }),
      ).toEqual({ count: 1 });
      expect(await b.tasks.find({ where: { id: T1 }, limit: 1 })).toMatchObject([{ team: null }]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "manyThrough names its join table, and an ambiguous or unknown one fails when the schema is built",
  async () => {
    const { schema, table, id, uuid, manyThrough } = await import("../src/dialects/pg/index.js");
    const people = (relations: Record<string, ReturnType<typeof manyThrough>>) =>
      table("people", { id: id({ default: "none" }) }, { relations });
    const friends = table("friends", {
      id: id({ default: "none" }),
      left: uuid().references("people"),
      right: uuid().references("people"),
    });
    const build = (relation: ReturnType<typeof manyThrough>) =>
      schema({ tables: [people({ friends: relation }), friends] });
    expect(() => build(manyThrough("people", { through: "friends" }))).toThrow(/ambiguous/);
    expect(() => build(manyThrough("people", { through: "nope" }))).toThrow(/not in the schema/);
    const ok = build(manyThrough("people", { through: "friends", from: "left", to: "right" }));
    const relation = ok.model.people?.relations[0];
    expect(relation?.through?.table).toBe("friends");
    expect(relation?.local).toEqual(["id"]);
    expect(relation?.remote).toEqual(["left"]);
    expect(relation?.through?.local).toEqual(["right"]);
    expect(relation?.through?.remote).toEqual(["id"]);
  },
);

postgresTest(
  gate,
  "one(), required(), and the small semantics of section 12",
  async () => {
    await withApp(async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      await a.tasks.insert([
        task("50% off", { score: 3, team: "x" }),
        task("50x off", { score: null, team: "x" }),
        task("a_b", { score: 1, team: "y" }),
        task("axb", { score: 2, team: "y" }),
        task("back\\slash", { score: null, team: null }),
      ]);
      const titles = (rows: readonly { readonly title: string }[]): string[] =>
        rows.map((row) => row.title).sort();

      // one(): more than one is not_unique unless ordered; required() turns null into not_found.
      expect((await catchError(a.tasks.one({ where: { team: "x" } }))).code).toBe("not_unique");
      expect((await a.tasks.one({ where: { team: "x" }, orderBy: { score: "asc" } }))?.title).toBe(
        "50% off",
      );
      const missing = a.tasks.one({ where: { title: "nope" } });
      expect(await missing).toBeNull();
      expect((await catchError(a.tasks.one({ where: { title: "nope" } }).required())).code).toBe(
        "not_found",
      );
      const planned = await a.tasks.one({ where: { team: "x" } }).sql();
      expect(planned.text).toMatch(/ limit 2$/);

      // inList([]) matches nothing, notIn([]) matches everything.
      expect(await a.tasks.find({ where: { title: inList([]) }, limit: 10 })).toEqual([]);
      expect(await a.tasks.find({ where: { title: notIn([]) }, limit: 10 })).toHaveLength(5);

      // Null ordering: asc is nulls last, desc is nulls first, `nulls` overrides.
      const scores = async (orderBy: object): Promise<(number | null)[]> =>
        (
          await a.tasks.find({
            orderBy: orderBy as { score: "asc" },
            select: ["score"],
            limit: 10,
          })
        ).map((row) => row.score);
      expect(await scores({ score: "asc" })).toEqual([1, 2, 3, null, null]);
      expect(await scores({ score: "desc" })).toEqual([null, null, 3, 2, 1]);
      expect(await scores({ score: { dir: "asc", nulls: "first" } })).toEqual([
        null,
        null,
        1,
        2,
        3,
      ]);
      expect(await scores({ score: { dir: "desc", nulls: "last" } })).toEqual([
        3,
        2,
        1,
        null,
        null,
      ]);

      // Text patterns are literal.
      expect(
        titles(await a.tasks.find({ where: { title: startsWith("50%") }, limit: 10 })),
      ).toEqual(["50% off"]);
      expect(titles(await a.tasks.find({ where: { title: contains("_") }, limit: 10 }))).toEqual([
        "a_b",
      ]);
      expect(
        titles(await a.tasks.find({ where: { title: endsWith("\\slash") }, limit: 10 })),
      ).toEqual(["back\\slash"]);

      // expect: a count that differs is not_found.
      const ghost = crypto.randomUUID();
      expect(
        (
          await catchError(
            a.tasks.update({ where: { id: ghost }, set: { team: "z" } }, { expect: 1 }),
          )
        ).code,
      ).toBe("not_found");
      expect((await catchError(a.tasks.delete({ where: { id: ghost } }, { expect: 1 }))).code).toBe(
        "not_found",
      );
      expect(
        await a.tasks.update({ where: { team: "y" }, set: { team: "z" } }, { expect: 2 }),
      ).toEqual({
        count: 2,
      });
    });
  },
  60_000,
);

type Walk = {
  readonly items: readonly { readonly id: string }[];
  readonly next: string | null;
};

async function walk(read: (after: string | null) => PromiseLike<Walk>): Promise<string[]> {
  const seen: string[] = [];
  let after: string | null = null;
  for (let guard = 0; guard < 200; guard += 1) {
    const page: Walk = await read(after);
    seen.push(...page.items.map((item) => item.id));
    if (page.next === null) return seen;
    after = page.next;
  }
  throw new Error("page() did not end");
}

postgresTest(
  gate,
  "page is a keyset: stable under inserts, tenant and archive aware, order-bound",
  async () => {
    await withApp(async (db, sql, schemaName) => {
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      const names = Array.from(
        { length: 10 },
        (_, index) => `a${String(index + 1).padStart(2, "0")}`,
      );
      await a.tasks.insert(names.map((title) => task(title)));
      await b.tasks.insert([task("b-only")]);

      const first = await a.tasks.page({ orderBy: { title: "asc" }, limit: 3 });
      expect(first.items.map((item) => item.title)).toEqual(["a01", "a02", "a03"]);
      expect(first.next).not.toBeNull();
      // Rows arrive before and inside the unread range while the reader holds a cursor.
      await a.tasks.insert([task("a00"), task("a035")]);
      const second = await a.tasks.page({ orderBy: { title: "asc" }, limit: 3, after: first.next });
      expect(second.items.map((item) => item.title)).toEqual(["a035", "a04", "a05"]);
      const rest = await a.tasks.page({ orderBy: { title: "asc" }, limit: 20, after: second.next });
      expect(rest.items.map((item) => item.title)).toEqual(["a06", "a07", "a08", "a09", "a10"]);
      expect(rest.next).toBeNull();

      // The cursor is bound to its order.
      const reused = await catchError(
        a.tasks.page({ orderBy: { title: "desc" }, limit: 3, after: first.next }),
      );
      expect(reused.code).toBe("OKM1130");
      expect((await catchError(a.tasks.page({ limit: 3, after: first.next }))).code).toBe(
        "OKM1130",
      );
      expect(
        (
          await catchError(
            a.tasks.page({ orderBy: { title: "asc" }, limit: 3, after: "not a cursor" }),
          )
        ).code,
      ).toBe("OKM1130");
      expect((await catchError(a.tasks.page({ orderBy: { title: "asc" }, limit: 0 }))).code).toBe(
        "invalid",
      );
      expect(
        (
          await catchError(
            (a.tasks as unknown as { page(o: object): PromiseLike<unknown> }).page({
              orderBy: { title: "asc" },
            }),
          )
        ).code,
      ).toBe("OKM1101");

      // Another tenant's cursor reveals nothing: the scope is still the client's.
      const foreign = await b.tasks.page({
        orderBy: { title: "asc" },
        limit: 5,
        after: first.next,
      });
      expect(foreign.items.map((item) => item.title)).toEqual(["b-only"]);

      // Archived rows are not in a page until the view is widened.
      await a.tasks.archive({ where: { title: "a05" } });
      const all = await walk((after) =>
        a.tasks.page({ orderBy: { title: "asc" }, limit: 4, after }),
      );
      expect(all).toHaveLength(11);
      const wide = await walk((after) =>
        a.tasks.withArchived().page({ orderBy: { title: "asc" }, limit: 4, after }),
      );
      expect(wide).toHaveLength(12);
      const planned = await a.tasks
        .page({ orderBy: { title: "asc" }, limit: 2, after: first.next })
        .sql();
      expect(planned.text).toContain('"archived_at" is null');
      expect(planned.text).toContain('"tenant_id" = ');
      expect(planned.text).toContain("limit $");

      // select leaves the order key out of the items and still pages.
      const narrow = await a.tasks.page({ select: ["id"], orderBy: { title: "asc" }, limit: 2 });
      expect(Object.keys(narrow.items[0] ?? {})).toEqual(["id"]);
      expect(narrow.next).not.toBeNull();

      // Microsecond timestamps survive the cursor.
      await sql.unsafe(`delete from "${schemaName}"."tasks"`);
      const stamps = ["000100", "000200", "000300"];
      for (const [index, micro] of stamps.entries()) {
        await sql.unsafe(
          `insert into "${schemaName}"."tasks" (id, title, due, tenant_id) values ('${crypto.randomUUID()}', 't${String(index)}', '2024-01-01 00:00:00.${micro}+00', '${TENANT_A}')`,
        );
      }
      const order: string[] = [];
      let after: string | null = null;
      for (let guard = 0; guard < 5; guard += 1) {
        const page: { items: readonly { title: string }[]; next: string | null } =
          await a.tasks.page({
            orderBy: { due: "asc" },
            limit: 1,
            after,
          });
        order.push(...page.items.map((item) => item.title));
        if (page.next === null) break;
        after = page.next;
      }
      expect(order).toEqual(["t0", "t1", "t2"]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "aggregate groups inside the tenant and the active set",
  async () => {
    await withApp(async (db, sql, schemaName) => {
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      await a.tasks.insert([
        task("1", { team: "x", score: 10 }),
        task("2", { team: "x", score: 20 }),
        task("3", { team: "y", score: 6 }),
        task("4", { team: null, score: null }),
        task("5", { team: "x", score: 1000 }),
      ]);
      await b.tasks.insert([
        task("b1", { team: "x", score: 777 }),
        task("b2", { team: "z", score: 1 }),
      ]);
      await a.tasks.archive({ where: { title: "5" } });
      // The client does not write a Temporal value yet, so the dates go in as text.
      for (const [title, date] of [
        ["1", "05"],
        ["2", "03"],
        ["3", "09"],
      ] as const) {
        await sql.unsafe(
          `update "${schemaName}"."tasks" set due = '2024-01-${date}T00:00:00Z' where title = '${title}' and tenant_id = '${TENANT_A}'`,
        );
      }

      const groups = await a.tasks.aggregate({
        groupBy: ["team"],
        count: true,
        sum: ["score"],
        avg: ["score"],
        min: ["due"],
        max: ["score"],
        limit: 10,
      });
      expect(JSON.parse(JSON.stringify(groups))).toEqual([
        {
          team: "x",
          count: 2,
          sum: { score: 30 },
          avg: { score: 15 },
          min: { due: "2024-01-03T00:00:00Z" },
          max: { score: 20 },
        },
        {
          team: "y",
          count: 1,
          sum: { score: 6 },
          avg: { score: 6 },
          min: { due: "2024-01-09T00:00:00Z" },
          max: { score: 6 },
        },
        {
          team: null,
          count: 1,
          sum: { score: null },
          avg: { score: null },
          min: { due: null },
          max: { score: null },
        },
      ]);
      expect(await b.tasks.aggregate({ groupBy: ["team"], count: true, limit: 10 })).toEqual([
        { team: "x", count: 1 },
        { team: "z", count: 1 },
      ]);
      expect(await a.tasks.aggregate({ count: true, sum: ["score"] })).toEqual([
        { count: 4, sum: { score: 36 } },
      ]);
      expect(await a.tasks.withArchived().aggregate({ count: true, sum: ["score"] })).toEqual([
        { count: 5, sum: { score: 1036 } },
      ]);
      expect(await a.tasks.aggregate({ where: { team: "x" }, count: true })).toEqual([
        { count: 2 },
      ]);
      expect(
        await a.tasks.aggregate({
          groupBy: ["team"],
          count: true,
          orderBy: { team: "desc" },
          limit: 1,
        }),
      ).toEqual([{ team: null, count: 1 }]);
      expect(
        await a.tasks.aggregate({ groupBy: ["team"], count: true }).all("every group"),
      ).toHaveLength(3);
      expect(
        (
          await catchError(
            (a.tasks as unknown as { aggregate(o: object): PromiseLike<unknown> }).aggregate({
              groupBy: ["team"],
              count: true,
            }),
          )
        ).code,
      ).toBe("OKM1101");
      const planned = await a.tasks.aggregate({ groupBy: ["team"], count: true, limit: 3 }).sql();
      expect(planned.text).toContain('"tenant_id" = ');
      expect(planned.text).toContain('"archived_at" is null');
      expect(planned.text.includes(TENANT_A)).toBe(false);
      // A sum over text, and a field that does not exist, are refused.
      expect(
        (
          await catchError(
            (a.tasks as unknown as { aggregate(o: object): PromiseLike<unknown> }).aggregate({
              sum: ["title"],
            }),
          )
        ).code,
      ).toBe("OKM1124");
      expect(
        (
          await catchError(
            (a.tasks as unknown as { aggregate(o: object): PromiseLike<unknown> }).aggregate({
              count: true,
              groupBy: ["nope"],
              limit: 1,
            }),
          )
        ).code,
      ).toBe("OKM1120");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "paged results match a model: no row missed or repeated",
  async () => {
    await withApp(async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }), {
            minLength: 0,
            maxLength: 24,
          }),
          fc.integer({ min: 1, max: 7 }),
          fc.constantFrom("asc", "desc"),
          fc.constantFrom("first", "last", undefined),
          fc.boolean(),
          async (scores, size, dir, nulls, concurrent) => {
            await a.tasks.withArchived().delete({}).all("reset");
            const rows = scores.map((score) => ({ id: crypto.randomUUID(), score }));
            await a.tasks.insert(rows.map((row, index) => task(`r${String(index)}`, row)));
            const order = nulls === undefined ? dir : { dir, nulls };
            const nullsFirst = (nulls ?? (dir === "desc" ? "first" : "last")) === "first";
            const sign = dir === "asc" ? 1 : -1;
            const model = [...rows].sort((left, right) => {
              if (left.score !== right.score) {
                if (left.score === null) return nullsFirst ? -1 : 1;
                if (right.score === null) return nullsFirst ? 1 : -1;
                return (left.score - right.score) * sign;
              }
              return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
            });
            const got: string[] = [];
            let after: string | null = null;
            let inserted = false;
            for (let guard = 0; guard < 60; guard += 1) {
              const page: Walk = await a.tasks.page({
                orderBy: { score: order },
                limit: size,
                after,
              });
              got.push(...page.items.map((item) => item.id));
              if (concurrent && !inserted && page.next !== null) {
                inserted = true;
                // A row that sorts anywhere must not break the walk. It may appear once or not at all.
                await a.tasks.insert({ id: crypto.randomUUID(), title: "late", score: 2 });
              }
              if (page.next === null) break;
              after = page.next;
            }
            const expected: string[] = model.map((row) => row.id);
            const unique = new Set(got);
            expect(unique.size).toBe(got.length);
            expect(got.filter((id) => expected.includes(id))).toEqual(expected);
            expect(got.length - expected.length).toBeLessThanOrEqual(inserted ? 1 : 0);
          },
        ),
        { numRuns: 30 },
      );
    });
  },
  120_000,
);

postgresTest(
  gate,
  "aggregates decode with the source column's codec, so no digit is rounded",
  async () => {
    await withApp(async (db) => {
      const a = db.for({ tenantId: TENANT_A });
      const b = db.for({ tenantId: TENANT_B });
      const row = (account: string, amount: string, big: string, rate: number) => ({
        id: crypto.randomUUID(),
        account,
        amount,
        big,
        rate,
      });
      // A JavaScript number holds 9007199254740992 and rounds the next integer.
      // 0.10 + 0.20 is 0.30000000000000004 as a number.
      await a.ledger.insert([
        row("x", "9007199254740993.25", "9223372036854775806", 0.1),
        row("x", "0.10", "1", 0.2),
        row("x", "0.20", "1", 0.3),
        row("y", "1.50", "7", 1.25),
      ]);
      await b.ledger.insert([row("x", "100.00", "5", 9)]);

      const grouped = await a.ledger.aggregate({
        groupBy: ["account"],
        count: true,
        sum: ["amount", "big", "rate"],
        avg: ["amount"],
        min: ["amount", "big"],
        max: ["amount", "rate"],
        limit: 5,
      });
      expect(grouped).toEqual([
        {
          account: "x",
          count: 3,
          // numeric follows the numeric codec: an exact decimal string by default.
          sum: { amount: "9007199254740993.55", big: "9223372036854775808", rate: 0.6 },
          avg: { amount: "3002399751580331.1833" },
          // min and max follow the column.
          min: { amount: "0.10", big: "1" },
          max: { amount: "9007199254740993.25", rate: 0.3 },
        },
        {
          account: "y",
          count: 1,
          sum: { amount: "1.50", big: "7", rate: 1.25 },
          avg: { amount: "1.50000000000000000000" },
          min: { amount: "1.50", big: "7" },
          max: { amount: "1.50", rate: 1.25 },
        },
      ]);
      // The strings are exact where a number is not.
      expect(String(Number("9007199254740993.55"))).not.toBe("9007199254740993.55");
      expect(String(Number("9223372036854775808"))).not.toBe("9223372036854775808");
      // count stays a number, and a sum cannot cross the tenant.
      expect(typeof grouped[0]?.count).toBe("number");
      expect(await b.ledger.aggregate({ sum: ["amount"] })).toEqual([
        { sum: { amount: "100.00" } },
      ]);
      expect(await a.ledger.aggregate({ where: { account: "none" }, sum: ["amount"] })).toEqual([
        { sum: { amount: null } },
      ]);
    });
  },
  60_000,
);
