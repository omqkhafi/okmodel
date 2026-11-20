/**
 * `computed`: relation aggregates in the same statement, on real Postgres.
 *
 * Every value is compared with a plain JavaScript count over the seeded rows.
 * The statement shape is asserted too: one grouped subquery per relation, no
 * per-row subquery, and `exists` for a threshold.
 */

import { expect } from "bun:test";

import { renderCatalog } from "../src/dialects/pg/ddl.js";
import {
  between,
  fragment,
  gt,
  gte,
  ident,
  integer,
  lt,
  lte,
  many,
  one,
  schema,
  table,
  text,
} from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { archivable } from "../src/runtime/traits/index.js";
import { app as linked, TENANT_A as LINK_A, TENANT_B as LINK_B } from "./relations-schema.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c41";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c42";

const users = table(
  "users",
  { id: text().primaryKey(), name: text() },
  { relations: { posts: many("posts") } },
);

const posts = table(
  "posts",
  {
    id: text().primaryKey(),
    userId: text().references("users"),
    topic: text(),
    views: integer().nullable(),
    secret: text().nullable().hidden(),
  },
  {
    traits: [archivable()],
    relations: { user: one("users", "userId"), comments: many("comments") },
  },
);

const comments = table("comments", {
  id: text().primaryKey(),
  postId: text().references("posts"),
  body: text(),
});

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [users, posts, comments],
});

const gate = await loadPostgresGate();

const uid = (n: number): string => `01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9${String(n).padStart(3, "0")}`;
const [T1, T2, T3, L1, L2, L3, K1, K2, K3, K4] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(uid) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

type Db = ReturnType<typeof connect<typeof app>>;

type PostSeed = {
  readonly id: string;
  readonly userId: string;
  readonly topic: string;
  readonly views: number | null;
};

const TOPICS = ["a", "b", "c"] as const;

/** Twenty-four users with 0 to 5 posts each. Views repeat so a distinct count differs from a count. */
function seed(): { readonly users: readonly string[]; readonly posts: readonly PostSeed[] } {
  const names: string[] = [];
  const rows: PostSeed[] = [];
  for (let u = 0; u < 24; u += 1) {
    const userId = `u${String(u).padStart(2, "0")}`;
    names.push(userId);
    for (let p = 0; p < (u * 7) % 6; p += 1) {
      rows.push({
        id: `${userId}-p${String(p)}`,
        userId,
        topic: TOPICS[(u + p) % 3] ?? "a",
        views: (u + p) % 4 === 3 ? null : ((u * 3 + p * 5) % 7) + 1,
      });
    }
  }
  return { users: names, posts: rows };
}

async function withApp(run: (db: Db) => Promise<void>): Promise<void> {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
    const db = connect(primaryUrl(), { schema: app, searchPath: schemaName, max: 4 });
    try {
      await db.connected;
      await run(db);
    } finally {
      await db.close();
    }
  });
}

async function seeded(db: Db): Promise<ReturnType<Db["for"]>> {
  const a = db.for({ tenantId: TENANT_A });
  const data = seed();
  await a.users.insert(data.users.map((userId) => ({ id: userId, name: `n-${userId}` })));
  await a.posts.insert(data.posts.map((post) => ({ ...post, secret: "s" })));
  return a;
}

/** What the database must return, counted in JavaScript. */
function oracle(rows: readonly PostSeed[], userId: string, topic?: string) {
  const mine = rows.filter((post) => post.userId === userId);
  const hit = topic === undefined ? mine : mine.filter((post) => post.topic === topic);
  const views = hit.flatMap((post) => (post.views === null ? [] : [post.views]));
  const total = views.reduce((sum, value) => sum + value, 0);
  return {
    count: mine.length,
    exists: hit.length > 0,
    distinct: new Set(views).size,
    sum: views.length === 0 ? null : total,
    avg: views.length === 0 ? null : total / views.length,
    min: views.length === 0 ? null : Math.min(...views),
    max: views.length === 0 ? null : Math.max(...views),
    filtered: hit.length,
  };
}

function count(sql: string, part: string): number {
  return sql.split(part).length - 1;
}

postgresTest(
  gate,
  "every verb equals a count over the seeded rows",
  async () => {
    await withApp(async (db) => {
      const a = await seeded(db);
      const data = seed();
      const rows = await a.users.find({
        orderBy: { id: "asc" },
        limit: 100,
        computed: {
          n: (u) => u.posts.count(),
          topicA: (u) => u.posts.count({ where: { topic: "a" } }),
          kinds: (u) => u.posts.count({ distinct: "views" }),
          any: (u) => u.posts.exists({ where: { topic: "b" } }),
          sum: (u) => u.posts.sum("views"),
          avg: (u) => u.posts.avg("views"),
          min: (u) => u.posts.min("views"),
          max: (u) => u.posts.max("views"),
          top: (u) => u.posts.max("topic", { where: { topic: "a" } }),
          doubled: (u) => u.posts.sum(fragment`${ident("views")} * 2`),
          ratio: (u) => fragment`${u.posts.sum("views")}::numeric / nullif(${u.posts.count()}, 0)`,
        },
      });
      expect(rows).toHaveLength(24);
      for (const row of rows) {
        const all = oracle(data.posts, row.id);
        const onlyA = oracle(data.posts, row.id, "a");
        const onlyB = oracle(data.posts, row.id, "b");
        expect(row.n).toBe(all.count);
        expect(row.topicA).toBe(onlyA.filtered);
        expect(row.kinds).toBe(all.distinct);
        expect(row.any).toBe(onlyB.exists);
        expect(row.sum).toBe(all.sum);
        if (all.avg === null) expect(row.avg).toBeNull();
        else expect(row.avg).toBeCloseTo(all.avg, 9);
        expect(row.min).toBe(all.min);
        expect(row.max).toBe(all.max);
        expect(row.top).toBe(onlyA.filtered === 0 ? null : "a");
        expect(row.doubled).toBe(all.sum === null ? null : all.sum * 2);
        if (all.sum === null || all.count === 0) expect(row.ratio).toBeNull();
        else expect(row.ratio).toBeCloseTo(all.sum / all.count, 9);
      }
      expect(rows.some((row) => row.n === 0)).toBe(true);
      expect(rows.some((row) => row.sum === null)).toBe(true);
    });
  },
  60_000,
);

type Counted = PromiseLike<readonly { readonly id: string; readonly n: number }[]> & {
  sql(): { readonly text: string } | Promise<{ readonly text: string }>;
};

postgresTest(
  gate,
  "a threshold in where is an exists inside the page, and other filters use the grouped form",
  async () => {
    await withApp(async (db) => {
      const a = await seeded(db);
      const data = seed();
      const n = (userId: string) => oracle(data.posts, userId).count;
      const check = async (
        label: string,
        read: Counted,
        keep: (c: number) => boolean,
        threshold: boolean | undefined,
      ): Promise<void> => {
        const found = await read;
        expect(
          found.map((row) => row.id),
          label,
        ).toEqual(data.users.filter((userId) => keep(n(userId))));
        for (const row of found) expect(row.n, label).toBe(n(row.id));
        const text = (await read.sql()).text;
        if (threshold === undefined) return;
        expect(text.includes("exists (select 1"), label).toBe(threshold);
        if (!threshold) expect(text, label).toContain("left join (select");
      };
      await check(
        "gte 3",
        a.users.find({
          where: { n: gte(3) },
          orderBy: { id: "asc" },
          limit: 100,
          computed: { n: (u) => u.posts.count() },
        }),
        (c) => c >= 3,
        true,
      );
      await check(
        "gte 1",
        a.users.find({
          where: { n: gte(1) },
          orderBy: { id: "asc" },
          limit: 100,
          computed: { n: (u) => u.posts.count() },
        }),
        (c) => c >= 1,
        true,
      );
      await check(
        "gte 0",
        a.users.find({
          where: { n: gte(0) },
          orderBy: { id: "asc" },
          limit: 100,
          computed: { n: (u) => u.posts.count() },
        }),
        () => true,
        undefined,
      );
      await check(
        "gt 2",
        a.users.find({
          where: { n: gt(2) },
          orderBy: { id: "asc" },
          limit: 100,
          computed: { n: (u) => u.posts.count() },
        }),
        (c) => c > 2,
        true,
      );
      await check(
        "lt 2",
        a.users.find({
          where: { n: lt(2) },
          orderBy: { id: "asc" },
          limit: 100,
          computed: { n: (u) => u.posts.count() },
        }),
        (c) => c < 2,
        true,
      );
      await check(
        "lte 0",
        a.users.find({
          where: { n: lte(0) },
          orderBy: { id: "asc" },
          limit: 100,
          computed: { n: (u) => u.posts.count() },
        }),
        (c) => c <= 0,
        true,
      );
      await check(
        "eq 0",
        a.users.find({
          where: { n: 0 },
          orderBy: { id: "asc" },
          limit: 100,
          computed: { n: (u) => u.posts.count() },
        }),
        (c) => c === 0,
        true,
      );
      await check(
        "eq 3",
        a.users.find({
          where: { n: 3 },
          orderBy: { id: "asc" },
          limit: 100,
          computed: { n: (u) => u.posts.count() },
        }),
        (c) => c === 3,
        false,
      );
      await check(
        "between",
        a.users.find({
          where: { n: between(2, 4) },
          orderBy: { id: "asc" },
          limit: 100,
          computed: { n: (u) => u.posts.count() },
        }),
        (c) => c >= 2 && c <= 4,
        false,
      );
    });
  },
  60_000,
);

postgresTest(
  gate,
  "an order by a computed value matches a sort over the seeded rows",
  async () => {
    await withApp(async (db) => {
      const a = await seeded(db);
      const data = seed();
      const by = (userId: string) => oracle(data.posts, userId).count;
      const rows = await a.users.find({
        orderBy: { n: "desc", id: "asc" },
        limit: 7,
        computed: { n: (u) => u.posts.count() },
      });
      const expected = [...data.users]
        .sort((x, y) => by(y) - by(x) || x.localeCompare(y))
        .slice(0, 7);
      expect(rows.map((row) => row.id)).toEqual(expected);

      const sums = await a.users.find({
        where: { n: gte(1) },
        orderBy: { total: { dir: "asc", nulls: "last" }, id: "asc" },
        limit: 100,
        computed: { n: (u) => u.posts.count(), total: (u) => u.posts.sum("views") },
      });
      const total = (userId: string) => oracle(data.posts, userId).sum;
      const left = data.users.filter((userId) => by(userId) >= 1);
      left.sort((x, y) => {
        const l = total(x);
        const r = total(y);
        if (l === r) return x.localeCompare(y);
        if (l === null) return 1;
        if (r === null) return -1;
        return l - r;
      });
      expect(sums.map((row) => row.id)).toEqual(left);

      const text = (
        await a.users
          .find({ orderBy: { n: "desc" }, limit: 5, computed: { n: (u) => u.posts.count() } })
          .sql()
      ).text;
      expect(text).toContain("left join (select");
    });
  },
  60_000,
);

postgresTest(
  gate,
  "one grouped subquery per relation, and no subquery per row",
  async () => {
    await withApp(async (db) => {
      const a = await seeded(db);
      const same = (
        await a.users
          .find({
            limit: 10,
            orderBy: { id: "asc" },
            computed: {
              n: (u) => u.posts.count(),
              s: (u) => u.posts.sum("views"),
              m: (u) => u.posts.max("views"),
              e: (u) => u.posts.exists(),
              f: (u) => u.posts.count({ where: { topic: "a" } }),
            },
          })
          .sql()
      ).text;
      expect(count(same, "left join (select"), same).toBe(1);
      expect(count(same, "group by"), same).toBe(1);
      expect(same).toContain("okm_pg");
      expect(same).toContain("as materialized");
      expect(same).toMatch(/filter\s*\(\s*where/);
      expect(same).not.toContain("lateral");
      expect(count(same, 'from "posts"'), same).toBe(1);
      expect(/\(\s*select\s+count\(/i.test(same), same).toBe(false);

      const comments = (
        await a.posts
          .find({ limit: 5, orderBy: { id: "asc" }, computed: { c: (p) => p.comments.count() } })
          .sql()
      ).text;
      expect(count(comments, "left join (select")).toBe(1);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "tenant and archive guards apply to the related rows",
  async () => {
    await withApp(async (db) => {
      const a = await seeded(db);
      const b = db.for({ tenantId: TENANT_B });
      await b.users.insert([{ id: "u05", name: "other" }]);
      await b.posts.insert([
        { id: "x1", userId: "u05", topic: "a", views: 1 },
        { id: "x2", userId: "u05", topic: "a", views: 1 },
        { id: "x3", userId: "u05", topic: "a", views: 1 },
      ]);
      const data = seed();
      const before = await a.users.one({
        where: { id: "u05" },
        computed: { n: (u) => u.posts.count() },
      });
      expect(before?.n).toBe(oracle(data.posts, "u05").count);
      const mine = await b.users.one({
        where: { id: "u05" },
        computed: { n: (u) => u.posts.count() },
      });
      expect(mine?.n).toBe(3);

      await a.posts.archive({ where: { id: "u05-p0" } });
      const after = await a.users.one({
        where: { id: "u05" },
        computed: { n: (u) => u.posts.count(), any: (u) => u.posts.exists() },
      });
      expect(after?.n).toBe(oracle(data.posts, "u05").count - 1);
      const filtered = await a.users.find({
        where: { n: gte(oracle(data.posts, "u05").count) },
        limit: 50,
        computed: { n: (u) => u.posts.count() },
      });
      expect(filtered.map((row) => row.id)).not.toContain("u05");

      const text = (await a.users.find({ limit: 1, computed: { n: (u) => u.posts.count() } }).sql())
        .text;
      expect(text).toContain('"tenant_id"');
      expect(text).toContain('"archived_at" is null');
      expect(text.includes(TENANT_A)).toBe(false);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "one, count, exists, page, and stream equal find",
  async () => {
    await withApp(async (db) => {
      const a = await seeded(db);
      const where = { n: gte(2) };
      const all = await a.users.find({
        where,
        orderBy: { id: "asc" },
        limit: 100,
        computed: { n: (u) => u.posts.count() },
      });
      expect(all.length).toBeGreaterThan(3);

      const first = await a.users.one({
        where,
        orderBy: { id: "asc" },
        computed: { n: (u) => u.posts.count() },
      });
      expect(first).toEqual(all[0] ?? null);

      expect(await a.users.count({ where, computed: { n: (u) => u.posts.count() } })).toBe(
        all.length,
      );
      expect(await a.users.exists({ where, computed: { n: (u) => u.posts.count() } })).toBe(true);
      expect(
        await a.users.exists({
          where: { n: gte(99) },
          computed: { n: (u) => u.posts.count() },
        }),
      ).toBe(false);

      const streamed = [];
      const read = a.users.find({
        where,
        orderBy: { id: "asc" },
        limit: 100,
        computed: { n: (u) => u.posts.count() },
      });
      for await (const row of read.stream({ batch: 3 })) streamed.push(row);
      expect(streamed).toEqual([...all]);

      const pages = [];
      let after: string | null = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const page: { items: typeof all; next: string | null } = await a.users.page({
          where,
          orderBy: { id: "asc" },
          limit: 4,
          after,
          computed: { n: (u) => u.posts.count() },
        });
        pages.push(...page.items);
        if (page.next === null) break;
        after = page.next;
      }
      expect(pages).toEqual([...all]);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a stream reads one snapshot, so a write between batches does not change its counts",
  async () => {
    await withApp(async (db) => {
      const a = await seeded(db);
      const data = seed();
      const seen: { id: string; n: number }[] = [];
      let wrote = false;
      const read = a.users.find({
        orderBy: { id: "asc" },
        limit: 100,
        computed: { n: (u) => u.posts.count() },
      });
      for await (const row of read.stream({ batch: 4 })) {
        seen.push({ id: row.id, n: row.n });
        if (!wrote) {
          wrote = true;
          await a.posts.insert([
            { id: "late1", userId: "u23", topic: "a", views: 1 },
            { id: "late2", userId: "u23", topic: "a", views: 1 },
          ]);
        }
      }
      expect(seen).toHaveLength(24);
      for (const row of seen) expect(row.n, row.id).toBe(oracle(data.posts, row.id).count);
      const now = await a.users.one({
        where: { id: "u23" },
        computed: { n: (u) => u.posts.count() },
      });
      expect(now?.n).toBe(oracle(data.posts, "u23").count + 2);
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a manyThrough relation counts through the join table, with tenant and archive on both",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      for (const statement of renderCatalog(linked.catalog, schemaName)) {
        await sql.unsafe(statement);
      }
      const db = connect(primaryUrl(), { schema: linked, searchPath: schemaName, max: 4 });
      try {
        await db.connected;
        const a = db.for({ tenantId: LINK_A });
        const b = db.for({ tenantId: LINK_B });
        await a.tasks.insert([
          { id: T1, title: "one" },
          { id: T2, title: "two" },
          { id: T3, title: "three" },
        ]);
        await a.labels.insert([
          { id: L1, name: "x" },
          { id: L2, name: "y" },
          { id: L3, name: "z" },
        ]);
        await a.taskLabels.insert([
          { id: K1, taskId: T1, labelId: L1 },
          { id: K2, taskId: T1, labelId: L2 },
          { id: K3, taskId: T1, labelId: L3 },
          { id: K4, taskId: T2, labelId: L1 },
        ]);
        await b.tasks.insert([{ id: T1, title: "other" }]);
        await b.labels.insert([{ id: L1, name: "q" }]);
        await b.taskLabels.insert([{ id: K1, taskId: T1, labelId: L1 }]);

        const read = async () =>
          a.tasks.find({
            orderBy: { id: "asc" },
            limit: 10,
            computed: {
              labelCount: (t) => t.labels.count(),
              names: (t) => t.labels.min("name"),
              tagged: (t) => t.labels.exists({ where: { name: "z" } }),
            },
          });
        expect(
          (await read()).map((row) => [row.id, row.labelCount, row.names, row.tagged]),
        ).toEqual([
          [T1, 3, "x", true],
          [T2, 1, "x", false],
          [T3, 0, null, false],
        ]);
        const byLabel = await a.labels.find({
          where: { taskCount: gte(2) },
          orderBy: { id: "asc" },
          limit: 10,
          computed: { taskCount: (l) => l.tasks.count() },
        });
        expect(byLabel.map((row) => [row.id, row.taskCount])).toEqual([[L1, 2]]);

        await a.labels.archive({ where: { id: L3 } });
        await a.taskLabels.archive({ where: { id: K2 } });
        expect((await read()).map((row) => [row.id, row.labelCount])).toEqual([
          [T1, 1],
          [T2, 1],
          [T3, 0],
        ]);
        const text = (
          await a.tasks.find({ limit: 5, computed: { n: (t) => t.labels.count() } }).sql()
        ).text;
        expect(count(text, "left join (select")).toBe(1);
      } finally {
        await db.close();
      }
    });
  },
  60_000,
);

postgresTest(
  gate,
  "a hidden field is refused in every verb and in where",
  async () => {
    await withApp(async (db) => {
      const a = await seeded(db);
      const reads = [
        () => a.users.find({ limit: 1, computed: { x: (u) => u.posts.max("secret" as never) } }),
        () =>
          a.users.find({
            limit: 1,
            computed: { x: (u) => u.posts.count({ where: { secret: "s" } as never }) },
          }),
        () =>
          a.users.find({
            limit: 1,
            computed: { x: (u) => u.posts.count({ distinct: "secret" as never }) },
          }),
        () =>
          a.users.find({
            limit: 1,
            computed: { x: (u) => u.posts.sum(fragment`${ident("secret")}::int`) },
          }),
      ];
      for (const read of reads) {
        const error = await read().then(
          () => undefined,
          (thrown: unknown) =>
            thrown as { code: string; message: string; fix?: { summary: string } },
        );
        expect(error?.code).toBe("OKM1120");
        expect(error?.message).toContain("secret");
        expect(error?.fix?.summary.length ?? 0).toBeGreaterThan(0);
      }
    });
  },
  60_000,
);
