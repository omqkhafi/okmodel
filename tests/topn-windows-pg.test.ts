/**
 * Top-N per parent in a to-many include, and window helpers.
 *
 * PGlite always runs. postgres.js runs when the topology is up.
 */

import { expect, test } from "bun:test";

import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import {
  denseRank,
  id,
  inList,
  integer,
  many,
  matches,
  rank,
  relevance,
  rowNumber,
  runningTotal,
  schema,
  table,
  text,
  tsvector,
  uuid,
} from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import type { Connected } from "../src/runtime/types.js";

const TENANT_A = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c21";
const TENANT_B = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c22";

const POST_A = "00000000-0000-4000-8000-000000000001";
const POST_B = "00000000-0000-4000-8000-000000000002";
const POST_EMPTY = "00000000-0000-4000-8000-000000000003";
const POST_S = "00000000-0000-4000-8000-000000000004";
const POST_S2 = "00000000-0000-4000-8000-000000000005";

const C_A1 = "00000000-0000-4000-8000-000000000011";
const C_A2 = "00000000-0000-4000-8000-000000000012";
const C_A3 = "00000000-0000-4000-8000-000000000013";
const C_A4 = "00000000-0000-4000-8000-000000000014";
const C_B1 = "00000000-0000-4000-8000-000000000021";
const C_B3 = "00000000-0000-4000-8000-000000000023";
const C_OTHER = "00000000-0000-4000-8000-000000000029";
const C_S1 = "00000000-0000-4000-8000-000000000041";
const C_S2 = "00000000-0000-4000-8000-000000000042";
const C_S3 = "00000000-0000-4000-8000-000000000043";

const R1 = "00000000-0000-4000-8000-000000000031";
const R2 = "00000000-0000-4000-8000-000000000032";
const R3 = "00000000-0000-4000-8000-000000000033";

const T1 = "00000000-0000-4000-8000-000000000051";
const T2 = "00000000-0000-4000-8000-000000000052";
const T3 = "00000000-0000-4000-8000-000000000053";
const T4 = "00000000-0000-4000-8000-000000000054";
const T5 = "00000000-0000-4000-8000-000000000055";
const T6 = "00000000-0000-4000-8000-000000000056";

const posts = table(
  "posts",
  { id: id({ default: "none" }), title: text() },
  {
    relations: { comments: many("comments") },
    presets: { titled: (q, title: string) => q.where({ title }) },
  },
);

const comments = table(
  "comments",
  {
    id: id({ default: "none" }),
    postId: uuid().references("posts"),
    body: text(),
    score: integer(),
    doc: tsvector(),
  },
  { relations: { replies: many("replies") } },
);

const replies = table("replies", {
  id: id({ default: "none" }),
  commentId: uuid().references("comments"),
  body: text(),
});

const tasks = table(
  "tasks",
  {
    id: id({ default: "none" }),
    status: text(),
    amount: integer(),
    note: text().hidden(),
  },
  { presets: { open: (q) => q.where({ status: "open" }) } },
);

const app = schema({
  casing: "snake",
  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
  tables: [posts, comments, replies, tasks],
});

type Db = Connected<typeof app>;

const gate = await loadPostgresGate();

test("top-N per parent and windows on pglite", async () => {
  const pool = await openPglite();
  try {
    for (const statement of renderCatalog(app.catalog, "public")) await pool.execute(statement);
    const db = await connectPglite(pool, { schema: app });
    await db.connected;
    try {
      await prove(db);
    } finally {
      await db.close();
    }
  } finally {
    await pool.close();
  }
}, 60_000);

postgresTest(gate, "top-N per parent and windows on postgres.js", async () => {
  await withPostgresSchema(async (sql, schemaName) => {
    for (const statement of renderCatalog(app.catalog, schemaName)) await sql.unsafe(statement);
    const db = connectPostgres(primaryUrl(), { schema: app, searchPath: schemaName, max: 1 });
    await db.connected;
    try {
      await prove(db);
    } finally {
      await db.close();
    }
  });
});

async function prove(db: Db): Promise<void> {
  const a = db.for({ tenantId: TENANT_A });
  const b = db.for({ tenantId: TENANT_B });
  await a.posts.insert([
    { id: POST_A, title: "keep" },
    { id: POST_B, title: "other" },
    { id: POST_EMPTY, title: "empty" },
    { id: POST_S, title: "search" },
    { id: POST_S2, title: "search-b" },
  ]);
  await b.posts.insert({ id: POST_A, title: "keep" });
  const blank = "'x':1";
  await a.comments.insert([
    { id: C_A1, postId: POST_A, body: "a1", score: 1, doc: blank },
    { id: C_A2, postId: POST_A, body: "a2", score: 1, doc: blank },
    { id: C_A3, postId: POST_A, body: "a3", score: 1, doc: blank },
    { id: C_A4, postId: POST_A, body: "a4", score: 5, doc: blank },
    { id: C_B1, postId: POST_B, body: "b1", score: 1, doc: blank },
    { id: C_B3, postId: POST_B, body: "b3", score: 9, doc: blank },
    {
      id: "00000000-0000-4000-8000-000000000022",
      postId: POST_B,
      body: "b2",
      score: 1,
      doc: blank,
    },
    { id: C_S1, postId: POST_S, body: "weak", score: 0, doc: "'alpha':1" },
    { id: C_S2, postId: POST_S, body: "strong", score: 0, doc: "'alpha':1,2,3" },
    { id: C_S3, postId: POST_S2, body: "only", score: 0, doc: "'alpha':1" },
  ]);
  await b.comments.insert({ id: C_OTHER, postId: POST_A, body: "secret", score: 100, doc: blank });
  await a.replies.insert([
    { id: R1, commentId: C_A4, body: "first" },
    { id: R2, commentId: C_A4, body: "second" },
    { id: R3, commentId: C_A1, body: "other" },
  ]);
  await a.tasks.insert([
    { id: T1, status: "open", amount: 30, note: "hidden" },
    { id: T2, status: "open", amount: 10, note: "hidden" },
    { id: T3, status: "open", amount: 10, note: "hidden" },
    { id: T4, status: "open", amount: 0, note: "hidden" },
    { id: T5, status: "done", amount: 5, note: "hidden" },
  ]);
  await b.tasks.insert({ id: T6, status: "open", amount: 100, note: "hidden" });

  const listed = await a.posts.find({
    where: { title: "keep" },
    limit: 5,
    include: {
      comments: {
        select: ["id", "score"],
        orderBy: { score: "desc" },
        limit: 2,
        include: { replies: { select: ["id"], orderBy: { id: "asc" }, limit: 1 } },
      },
    },
  });
  expect(listed).toHaveLength(1);
  const commentsA = listed[0]?.comments ?? [];
  expect(commentsA.map((row) => row.id)).toEqual([C_A4, C_A1]);
  expect(childIds(commentsA[0], "replies")).toEqual([R1]);
  expect(childIds(commentsA[1], "replies")).toEqual([R3]);
  expect("body" in (commentsA[0] ?? {})).toBe(false);

  const both = await a.posts.find({
    where: { title: "other" },
    limit: 5,
    include: { comments: { orderBy: { score: "desc" }, limit: 2 } },
  });
  expect(both[0]?.comments.map((row) => row.id)).toEqual([C_B3, C_B1]);

  const empty = await a.posts.find({
    where: { id: POST_EMPTY },
    limit: 1,
    include: { comments: { limit: 2, orderBy: { score: "desc" } } },
  });
  expect(empty[0]?.comments).toEqual([]);

  const described = await a.posts
    .find({
      where: { id: POST_A },
      limit: 1,
      include: { comments: { orderBy: { score: "desc" }, limit: 2 } },
    })
    .sql();
  expect(described.text.includes(";")).toBe(false);
  expect(described.text).toContain("left join lateral");
  expect(described.text).toContain('"score" desc nulls first, r0_comments."id" asc');
  const inspected = await a.posts
    .find({
      where: { id: POST_A },
      limit: 1,
      include: { comments: { orderBy: { score: "desc" }, limit: 2 } },
    })
    .inspect();
  expect(inspected.plan.statements).toBe(1);

  const preset = await a.posts.titled("keep").find({
    limit: 5,
    include: { comments: { limit: 2, orderBy: { score: "desc" } } },
  });
  expect(preset.map((row) => row.id)).toEqual([POST_A]);
  expect(preset[0]?.comments.map((row) => row.id)).toEqual([C_A4, C_A1]);

  const ranked = await a.posts.find({
    where: { id: inList([POST_S, POST_S2]) },
    limit: 5,
    include: {
      comments: {
        where: { doc: matches("alpha") },
        orderBy: { doc: relevance("alpha"), id: "asc" },
        limit: 1,
        select: ["id"],
      },
    },
  });
  const searchPosts = [...ranked].sort((left, right) => (left.id < right.id ? -1 : 1));
  expect(searchPosts.map((row) => row.id)).toEqual([POST_S, POST_S2]);
  expect(searchPosts[0]?.comments.map((row) => row.id)).toEqual([C_S2]);
  expect(searchPosts[1]?.comments.map((row) => row.id)).toEqual([C_S3]);

  const numbers = await a.tasks.find({
    select: [
      "id",
      "status",
      "amount",
      rowNumber({ partitionBy: ["status"], orderBy: { amount: "desc" }, as: "n" }),
      rank({ partitionBy: ["status"], orderBy: { amount: "desc" }, as: "r" }),
      denseRank({ partitionBy: ["status"], orderBy: { amount: "desc" }, as: "d" }),
      runningTotal("amount", { partitionBy: ["status"], orderBy: { id: "asc" }, as: "soFar" }),
    ],
    orderBy: { id: "asc" },
    limit: 10,
  });
  const byId = new Map(numbers.map((row) => [row.id, row]));
  expect(byId.get(T1)).toMatchObject({ n: 1, r: 1, d: 1, soFar: 30 });
  expect(byId.get(T2)).toMatchObject({ n: 2, r: 2, d: 2, soFar: 40 });
  expect(byId.get(T3)).toMatchObject({ n: 3, r: 2, d: 2, soFar: 50 });
  expect(byId.get(T4)).toMatchObject({ n: 4, r: 4, d: 3, soFar: 50 });
  expect(byId.get(T5)).toMatchObject({ n: 1, r: 1, d: 1, soFar: 5, status: "done" });
  expect(byId.has(T6)).toBe(false);

  const opened = await a.tasks.open().find({
    select: ["id", rowNumber({ partitionBy: ["status"], orderBy: { amount: "desc" }, as: "n" })],
    limit: 10,
  });
  expect(opened.map((row) => row.id).sort()).toEqual([T1, T2, T3, T4].sort());
  expect(opened.find((row) => row.id === T1)?.n).toBe(1);

  const windowSql = await a.tasks
    .find({
      select: ["id", rowNumber({ partitionBy: ["status"], orderBy: { amount: "desc" }, as: "n" })],
      orderBy: { n: "asc" } as unknown as { readonly id: "asc" },
      limit: 10,
    })
    .sql();
  expect(windowSql.text.includes(";")).toBe(false);
  expect(windowSql.text).toContain('row_number() over (partition by t."status"');
  expect(windowSql.text).toContain("order by 2 asc nulls last");

  const withComments = await a.posts.find({
    select: ["id", rowNumber({ orderBy: { title: "asc" }, as: "n" })],
    include: { comments: { limit: 1, orderBy: { score: "desc" }, select: ["id"] } },
    where: { id: POST_A },
    limit: 1,
  });
  expect(withComments[0]?.n).toBe(1);
  expect(withComments[0]?.comments.map((row) => row.id)).toEqual([C_A4]);

  expect(
    await codeOf(() => a.tasks.find({ select: [rowNumber({ orderBy: {}, as: "n" })], limit: 1 })),
  ).toBe("OKM1120");
  expect(
    await codeOf(() =>
      a.tasks.find({
        select: [rowNumber({ partitionBy: ["missing"], orderBy: { id: "asc" }, as: "n" })],
        limit: 1,
      }),
    ),
  ).toBe("OKM1120");
  expect(
    await codeOf(() =>
      a.tasks.find({
        select: [rowNumber({ partitionBy: ["note"], orderBy: { id: "asc" }, as: "n" })],
        limit: 1,
      }),
    ),
  ).toBe("OKM1120");
  expect(
    await codeOf(() =>
      a.tasks.find({
        select: [runningTotal("status", { orderBy: { id: "asc" }, as: "soFar" })],
        limit: 1,
      }),
    ),
  ).toBe("OKM1124");
  expect(
    await codeOf(() => a.tasks.find({ select: [{ as: "n" } as never], limit: 1 } as never)),
  ).toBe("OKM1120");
  expect(
    await codeOf(() =>
      a.tasks.page({
        select: [rowNumber({ orderBy: { id: "asc" }, as: "n" }) as never],
        limit: 1,
      } as never),
    ),
  ).toBe("OKM1120");

  const prototypeKeys = [
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "then",
  ] as const;
  const windowCalls = [
    (key: string) => rowNumber({ orderBy: { id: "asc" }, as: key }),
    (key: string) => rank({ orderBy: { amount: "desc" }, as: key }),
    (key: string) => denseRank({ orderBy: { amount: "desc" }, as: key }),
    (key: string) => runningTotal("amount", { orderBy: { id: "asc" }, as: key }),
  ] as const;
  for (const make of windowCalls) {
    for (const key of prototypeKeys) {
      let error: OkmError | undefined;
      try {
        await a.tasks.find({ select: ["id", make(key)], limit: 1 }).sql();
      } catch (caught) {
        if (caught instanceof OkmError) error = caught;
      }
      expect(error?.code).toBe("OKM1120");
      expect(error?.message).toContain(key);
      expect(error?.message).toContain("prototype key");
    }
  }
  const after = await a.tasks.find({
    select: ["id", rowNumber({ partitionBy: ["status"], orderBy: { amount: "desc" }, as: "n" })],
    orderBy: { id: "asc" },
    limit: 10,
  });
  expect(after.find((row) => row.id === T1)?.n).toBe(1);
  const probe: { polluted?: boolean } = {};
  expect(probe.polluted).toBeUndefined();
  expect(typeof Object.prototype.toString).toBe("function");
  expect(typeof Object.prototype.hasOwnProperty).toBe("function");
  expect(typeof Object.prototype.constructor).toBe("function");
  expect(typeof Object.prototype.valueOf).toBe("function");
  expect(Object.prototype.hasOwnProperty("then")).toBe(false);
}

/**
 * Nested include rows are present at runtime. The result type names the
 * selected columns of the first include and does not add the nested relation.
 */
function childIds(row: object | undefined, key: string): readonly string[] {
  if (row === undefined) return [];
  const value = (row as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || !("id" in item)) continue;
    if (typeof item.id === "string") ids.push(item.id);
  }
  return ids;
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "none";
  } catch (error) {
    return error instanceof OkmError ? error.code : "other";
  }
}
