/**
 * `computed`: random data against a naive per-row oracle, on real Postgres.
 *
 * Three tenants, archived rows, owners with no children, null values, and tied
 * values. Every aggregate verb, `distinct`, a filtered count, `sum` on an
 * integer and on a numeric, `min` and `max` on dates, fragments, a relation
 * through a join table, and the thresholds and orders that use a computed
 * value are compared with a loop over the seeded rows.
 */

import { expect } from "bun:test";

import { renderCatalog } from "../src/dialects/pg/ddl.js";
import {
  date,
  fragment,
  gt,
  gte,
  ident,
  integer,
  lte,
  many,
  manyThrough,
  numeric,
  schema,
  table,
  text,
} from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import type { ComputedRow } from "../src/runtime/types.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { archivable } from "../src/runtime/traits/index.js";

const owners = table(
  "owners",
  { id: text().primaryKey(), name: text() },
  {
    relations: {
      items: many("items", "ownerId"),
      tags: manyThrough("tags", { through: "ownerTags" }),
    },
  },
);

const items = table(
  "items",
  {
    id: text().primaryKey(),
    ownerId: text().references("owners"),
    kind: text(),
    qty: integer().nullable(),
    price: numeric(10, 2).nullable(),
    due: date().nullable(),
  },
  { traits: [archivable()] },
);

const tags = table(
  "tags",
  { id: text().primaryKey(), label: text(), weight: integer().nullable() },
  { traits: [archivable()] },
);

const ownerTags = table(
  "ownerTags",
  {
    id: text().primaryKey(),
    ownerId: text().references("owners"),
    tagId: text().references("tags"),
  },
  { traits: [archivable()] },
);

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [owners, items, tags, ownerTags],
});

const gate = await loadPostgresGate();

const TENANTS = [
  "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d11",
  "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d12",
  "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9d13",
] as const;

type Item = {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly qty: number | null;
  readonly cents: number | null;
  readonly due: string | null;
  readonly archived: boolean;
};
type Tag = { readonly id: string; readonly label: string; readonly weight: number | null };
type Link = { readonly id: string; readonly ownerId: string; readonly tagId: string };
type World = {
  readonly owners: readonly string[];
  readonly items: readonly Item[];
  readonly tags: readonly Tag[];
  readonly links: readonly Link[];
  readonly deadLinks: ReadonlySet<string>;
};

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const money = (cents: number): string =>
  `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, "0")}`;

/** The same ids repeat in every tenant, so a leak between tenants changes a value. */
function world(seed: number): World {
  const rng = mulberry32(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rng() * list.length)] as T;
  const ownerIds = Array.from({ length: 16 }, (_, n) => `o${String(n).padStart(2, "0")}`);
  const itemRows: Item[] = [];
  for (const ownerId of ownerIds) {
    const count = rng() < 0.25 ? 0 : Math.floor(rng() * 8);
    for (let n = 0; n < count; n += 1) {
      itemRows.push({
        id: `${ownerId}-i${String(n)}`,
        ownerId,
        kind: pick(["a", "b", "c"]),
        qty: rng() < 0.25 ? null : 1 + Math.floor(rng() * 4),
        cents: rng() < 0.25 ? null : Math.floor(rng() * 5) * 250 + (rng() < 0.5 ? 5 : 0),
        due:
          rng() < 0.25
            ? null
            : `2024-0${String(1 + Math.floor(rng() * 4))}-1${String(Math.floor(rng() * 3))}`,
        archived: rng() < 0.2,
      });
    }
  }
  const tagRows: Tag[] = ["t0", "t1", "t2", "t3", "t4"].map((id) => ({
    id,
    label: pick(["x", "y", "z"]),
    weight: rng() < 0.3 ? null : 1 + Math.floor(rng() * 3),
  }));
  const links: Link[] = [];
  const dead = new Set<string>();
  for (const ownerId of ownerIds) {
    for (const tag of tagRows) {
      if (rng() < 0.4) continue;
      links.push({ id: `${ownerId}-${tag.id}`, ownerId, tagId: tag.id });
      if (rng() < 0.2) dead.add(`${ownerId}-${tag.id}`);
    }
  }
  return { owners: ownerIds, items: itemRows, tags: tagRows, links, deadLinks: dead };
}

type Model = ReturnType<typeof expected>;

/** Counts, sums, and extremes of one owner's live rows, in plain loops. */
function expected(data: World, ownerId: string, deadTags: ReadonlySet<string>) {
  const live = data.items.filter((item) => item.ownerId === ownerId && !item.archived);
  const qty = live.flatMap((item) => (item.qty === null ? [] : [item.qty]));
  const cents = live.flatMap((item) => (item.cents === null ? [] : [item.cents]));
  const due = live.flatMap((item) => (item.due === null ? [] : [item.due])).sort();
  const tagRows = data.links
    .filter((link) => link.ownerId === ownerId && !data.deadLinks.has(link.id))
    .map((link) => data.tags.find((tag) => tag.id === link.tagId))
    .filter((tag): tag is Tag => tag !== undefined && !deadTags.has(tag.id));
  const weights = tagRows.flatMap((tag) => (tag.weight === null ? [] : [tag.weight]));
  const sum = (values: readonly number[]): number | null =>
    values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
  const sumQty = sum(qty);
  return {
    n: live.length,
    kindA: live.filter((item) => item.kind === "a").length,
    distinctQty: new Set(qty).size,
    anyB: live.some((item) => item.kind === "b"),
    sumQty,
    avgQty: sumQty === null ? null : sumQty / qty.length,
    minQty: qty.length === 0 ? null : Math.min(...qty),
    maxQty: qty.length === 0 ? null : Math.max(...qty),
    sumPrice: cents.length === 0 ? null : money(cents.reduce((total, value) => total + value, 0)),
    minDue: due[0] ?? null,
    maxDue: due.at(-1) ?? null,
    doubled: sumQty === null ? null : sumQty * 2,
    ratio: sumQty === null || live.length === 0 ? null : sumQty / live.length,
    tagCount: tagRows.length,
    tagMax: weights.length === 0 ? null : Math.max(...weights),
    tagAny: tagRows.some((tag) => tag.label === "z"),
  };
}

const computed = {
  n: (o: OwnerHandle) => o.items.count(),
  kindA: (o: OwnerHandle) => o.items.count({ where: { kind: "a" } }),
  distinctQty: (o: OwnerHandle) => o.items.count({ distinct: "qty" }),
  anyB: (o: OwnerHandle) => o.items.exists({ where: { kind: "b" } }),
  sumQty: (o: OwnerHandle) => o.items.sum("qty"),
  avgQty: (o: OwnerHandle) => o.items.avg("qty"),
  minQty: (o: OwnerHandle) => o.items.min("qty"),
  maxQty: (o: OwnerHandle) => o.items.max("qty"),
  sumPrice: (o: OwnerHandle) => o.items.sum("price"),
  minDue: (o: OwnerHandle) => o.items.min("due"),
  maxDue: (o: OwnerHandle) => o.items.max("due"),
  doubled: (o: OwnerHandle) => o.items.sum(fragment`${ident("qty")} * 2`),
  ratio: (o: OwnerHandle) =>
    fragment`${o.items.sum("qty")}::numeric / nullif(${o.items.count()}, 0)`,
  tagCount: (o: OwnerHandle) => o.tags.count(),
  tagMax: (o: OwnerHandle) => o.tags.max("weight"),
  tagAny: (o: OwnerHandle) => o.tags.exists({ where: { label: "z" } }),
};

type Db = ReturnType<typeof connect<typeof app>>;
type Tenant = ReturnType<Db["for"]>;
type OwnerHandle = ComputedRow<typeof app, "owners">;

async function load(db: Db, tenant: Tenant, data: World, dead: Set<string>): Promise<void> {
  void db;
  await tenant.owners.insert(data.owners.map((id) => ({ id, name: `n-${id}` })));
  await tenant.tags.insert(data.tags.map((tag) => ({ ...tag })));
  await tenant.items.insert(
    data.items.map((item) => ({
      id: item.id,
      ownerId: item.ownerId,
      kind: item.kind,
      qty: item.qty,
      price: item.cents === null ? null : money(item.cents),
      due: item.due,
    })),
  );
  await tenant.ownerTags.insert(data.links.map((link) => ({ ...link })));
  for (const item of data.items) {
    if (item.archived) await tenant.items.archive({ where: { id: item.id } });
  }
  for (const id of data.deadLinks) await tenant.ownerTags.archive({ where: { id } });
  void dead;
}

function same(row: Record<string, unknown>, want: Model, id: string): void {
  const close = (value: unknown, target: number | null, name: string): void => {
    if (target === null) expect(value, `${id} ${name}`).toBeNull();
    else expect(Number(value), `${id} ${name}`).toBeCloseTo(target, 9);
  };
  expect(row.n, `${id} n`).toBe(want.n);
  expect(row.kindA, `${id} kindA`).toBe(want.kindA);
  expect(row.distinctQty, `${id} distinctQty`).toBe(want.distinctQty);
  expect(row.anyB, `${id} anyB`).toBe(want.anyB);
  expect(row.sumQty, `${id} sumQty`).toBe(want.sumQty);
  close(row.avgQty, want.avgQty, "avgQty");
  expect(row.minQty, `${id} minQty`).toBe(want.minQty);
  expect(row.maxQty, `${id} maxQty`).toBe(want.maxQty);
  expect(row.sumPrice, `${id} sumPrice`).toBe(want.sumPrice);
  expect(row.minDue, `${id} minDue`).toBe(want.minDue);
  expect(row.maxDue, `${id} maxDue`).toBe(want.maxDue);
  expect(row.doubled, `${id} doubled`).toBe(want.doubled);
  close(row.ratio, want.ratio, "ratio");
  expect(row.tagCount, `${id} tagCount`).toBe(want.tagCount);
  expect(row.tagMax, `${id} tagMax`).toBe(want.tagMax);
  expect(row.tagAny, `${id} tagAny`).toBe(want.tagAny);
}

async function run(seed: number, check: (a: Check) => Promise<void>): Promise<void> {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 4 });
    try {
      await db.connected;
      const worlds = TENANTS.map((_, index) => world(seed + index));
      for (const [index, tenantId] of TENANTS.entries()) {
        await load(db, db.for({ tenantId }), worlds[index] as World, new Set());
      }
      for (const [index, tenantId] of TENANTS.entries()) {
        await check({ db: db.for({ tenantId }), data: worlds[index] as World });
      }
    } finally {
      await db.close();
    }
  });
}

type Check = { readonly db: Tenant; readonly data: World };

for (const seed of [20_261_101, 7]) {
  postgresTest(
    gate,
    `every verb equals a loop over the rows of its own tenant (seed ${String(seed)})`,
    async () => {
      let sawEmpty = false;
      let sawNull = false;
      await run(seed, async ({ db, data }) => {
        const rows = await db.owners.find({ orderBy: { id: "asc" }, limit: 100, computed });
        expect(rows.map((row) => row.id)).toEqual([...data.owners]);
        for (const row of rows) {
          const want = expected(data, row.id, new Set());
          same(row, want, row.id);
          sawEmpty ||= want.n === 0;
          sawNull ||= want.sumQty === null;
        }
        expect(data.items.some((item) => item.archived)).toBe(true);
      });
      expect(sawEmpty).toBe(true);
      expect(sawNull).toBe(true);
    },
    120_000,
  );

  postgresTest(
    gate,
    `where, orderBy, count, exists, one, and page agree with the loop (seed ${String(seed)})`,
    async () => {
      await run(seed, async ({ db, data }) => {
        const model = new Map(data.owners.map((id) => [id, expected(data, id, new Set())]));
        const rowsWhere = async (where: object) =>
          (
            await db.owners.find({
              where,
              orderBy: { id: "asc" },
              limit: 100,
              computed: { n: computed.n, sumQty: computed.sumQty, tagCount: computed.tagCount },
            })
          ).map((row) => row.id);
        const ids = (test: (m: Model) => boolean): string[] =>
          data.owners.filter((id) => test(model.get(id) as Model));
        for (const k of [0, 1, 2, 3, 5]) {
          expect(await rowsWhere({ n: gte(k) }), `n >= ${String(k)}`).toEqual(ids((m) => m.n >= k));
        }
        expect(await rowsWhere({ n: lte(0) })).toEqual(ids((m) => m.n === 0));
        expect(await rowsWhere({ n: 2 })).toEqual(ids((m) => m.n === 2));
        expect(await rowsWhere({ sumQty: gt(4) })).toEqual(ids((m) => (m.sumQty ?? 0) > 4));
        expect(await rowsWhere({ n: gte(1), tagCount: gte(2) })).toEqual(
          ids((m) => m.n >= 1 && m.tagCount >= 2),
        );
        expect(await rowsWhere({ name: "n-o03", n: gte(0) })).toEqual(["o03"]);

        const ordered = await db.owners.find({
          orderBy: { n: "desc", id: "asc" },
          limit: 100,
          computed: { n: computed.n },
        });
        const byCount = [...data.owners].sort(
          (a, b) =>
            (model.get(b) as Model).n - (model.get(a) as Model).n || (a < b ? -1 : a > b ? 1 : 0),
        );
        expect(ordered.map((row) => row.id)).toEqual(byCount);
        const asc = await db.owners.find({
          orderBy: { sumQty: { dir: "asc", nulls: "last" }, id: "asc" },
          limit: 100,
          computed: { sumQty: computed.sumQty },
        });
        const bySum = [...data.owners].sort((a, b) => {
          const x = (model.get(a) as Model).sumQty;
          const y = (model.get(b) as Model).sumQty;
          if (x === y) return a < b ? -1 : 1;
          if (x === null) return 1;
          if (y === null) return -1;
          return x - y;
        });
        expect(asc.map((row) => row.id)).toEqual(bySum);

        expect(await db.owners.count({ where: { n: gte(2) }, computed: { n: computed.n } })).toBe(
          ids((m) => m.n >= 2).length,
        );
        expect(await db.owners.count({ where: { n: gte(99) }, computed: { n: computed.n } })).toBe(
          0,
        );
        expect(await db.owners.exists({ where: { n: gte(1) }, computed: { n: computed.n } })).toBe(
          ids((m) => m.n >= 1).length > 0,
        );
        expect(await db.owners.exists({ where: { n: gte(99) }, computed: { n: computed.n } })).toBe(
          false,
        );

        const first = data.owners[1] as string;
        const one = await db.owners.one({ where: { id: first }, computed });
        same(one as Record<string, unknown>, model.get(first) as Model, first);

        const seen: string[] = [];
        let after: string | null = null;
        for (let step = 0; step < 20; step += 1) {
          const page: {
            items: readonly { id: string; n: number }[];
            next: string | null;
          } = await db.owners.page({
            where: { n: gte(1) },
            orderBy: { id: "asc" },
            limit: 3,
            after,
            computed: { n: computed.n, sumQty: computed.sumQty },
          });
          for (const row of page.items) {
            expect(row.n).toBe((model.get(row.id) as Model).n);
            seen.push(row.id);
          }
          if (page.next === null) break;
          after = page.next;
        }
        expect(seen).toEqual(ids((m) => m.n >= 1));
      });
    },
    120_000,
  );

  postgresTest(
    gate,
    `a stream with computed equals find (seed ${String(seed)})`,
    async () => {
      await run(seed, async ({ db, data }) => {
        const read = db.owners.find({ orderBy: { id: "asc" }, limit: 100, computed });
        const streamed: Record<string, unknown>[] = [];
        for await (const row of read.stream({ batch: 5 })) streamed.push(row);
        expect(streamed.map((row) => row.id)).toEqual([...data.owners]);
        for (const row of streamed)
          same(row, expected(data, row.id as string, new Set()), row.id as string);
      });
    },
    120_000,
  );
}
