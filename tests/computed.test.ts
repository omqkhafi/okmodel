/**
 * `computed`: every refusal names the problem and a fix, and OKM2012 reports a
 * foreign key with no index. These calls fail or warn before any statement
 * runs, so a stub driver is enough.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import {
  fragment,
  gte,
  id,
  ident,
  index,
  integer,
  many,
  morph,
  morphMany,
  or,
  schema,
  table,
  text,
  uuid,
} from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { warnings, type WarningNotice } from "../src/runtime/warnings/index.js";

const pool = {
  capabilities: { transactions: "interactive", stream: false, listen: false, cancel: false },
  execute: () => Promise.resolve({ rows: [["170000", "PostgreSQL 17"]], count: 1, notices: [] }),
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
} as DriverPool;

const posts = table("posts", {
  id: id({ default: "none" }),
  userId: uuid().references("users"),
  views: integer().nullable(),
  body: text(),
  secret: text().nullable().hidden(),
});

const pings = table(
  "pings",
  { id: id({ default: "none" }), targetType: text(), targetId: uuid() },
  { relations: { target: morph("target", ["users"]) } },
);

const users = table(
  "users",
  { id: id({ default: "none" }), name: text() },
  {
    relations: {
      posts: many("posts", "userId"),
      pings: morphMany("pings", "target"),
    },
  },
);

const app = schema({ tables: [users, posts, pings] });

function client(options?: Parameters<typeof warnings>[0]) {
  return connect(pool, { schema: app, warnings: warnings({ env: "development", ...options }) });
}

async function refusal(run: () => PromiseLike<unknown>): Promise<OkmError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}

async function refused(
  run: () => PromiseLike<unknown>,
  code: string,
  message: string,
): Promise<void> {
  const error = await refusal(run);
  expect(error.code).toBe(code);
  expect(error.message).toContain(message);
  expect(error.fix?.summary.length ?? 0).toBeGreaterThan(0);
}

test("a name that is a field, a relation, or a prototype key is refused with a fix", async () => {
  const db = client();
  await refused(
    () => db.users.find({ limit: 1, computed: { name: (u) => u.posts.count() } }),
    "OKM1120",
    "computed name name is already a field",
  );
  await refused(
    () => db.users.find({ limit: 1, computed: { posts: (u) => u.posts.count() } }),
    "OKM1120",
    "computed name posts is already a relation",
  );
  await refused(
    () =>
      db.users.find({
        limit: 1,
        computed: Object.fromEntries([["__proto__", () => fragment`1`]]),
      }),
    "OKM1120",
    "__proto__",
  );
});

test("a one relation, a morph relation, and a field are not aggregated", async () => {
  const db = client();
  await refused(
    () =>
      db.pings.find({
        limit: 1,
        // @ts-expect-error a morph relation has no aggregate
        computed: { n: (p) => p.target.count() },
      }),
    "OKM1120",
    "morph relation",
  );
  await refused(
    () =>
      db.users.find({
        limit: 1,
        computed: { n: (u) => u.pings.count() },
      }),
    "OKM1120",
    "morph relation",
  );
  await refused(
    () =>
      db.posts.find({
        limit: 1,
        // @ts-expect-error a field is not a relation
        computed: { n: (p) => p.views.count() },
      }),
    "OKM1120",
    "views",
  );
});

test("a verb outside the list, an unknown option, and an unknown field are refused", async () => {
  const db = client();
  await refused(
    () =>
      db.users.find({
        limit: 1,
        // @ts-expect-error a verb outside the list
        computed: { n: (u) => u.posts.median("views") },
      }),
    "OKM1120",
    "not a computed verb",
  );
  await refused(
    () =>
      db.users.find({
        limit: 1,
        // @ts-expect-error an option outside the list
        computed: { n: (u) => u.posts.count({ limit: 1 }) },
      }),
    "OKM1120",
    "Option limit is not accepted",
  );
  await refused(
    () =>
      db.users.find({
        limit: 1,
        // @ts-expect-error a field that is not on the related table
        computed: { n: (u) => u.posts.max("nope") },
      }),
    "OKM1120",
    "Field nope is not on posts",
  );
  await refused(
    () =>
      db.users.find({
        limit: 1,
        computed: { n: (u) => u.posts.count({ where: { nope: 1 } as never }) },
      }),
    "OKM1120",
    "nope",
  );
});

test("a hidden field is refused in each verb, in where, and in a fragment", async () => {
  const db = client();
  const hidden = "is hidden";
  await refused(
    () => db.users.find({ limit: 1, computed: { n: (u) => u.posts.max("secret" as never) } }),
    "OKM1120",
    hidden,
  );
  await refused(
    () =>
      db.users.find({
        limit: 1,
        computed: { n: (u) => u.posts.count({ where: { secret: "x" } as never }) },
      }),
    "OKM1120",
    "secret",
  );
  await refused(
    () =>
      db.users.find({
        limit: 1,
        computed: { n: (u) => u.posts.sum(fragment`${ident("secret")}::int`) },
      }),
    "OKM1120",
    "secret",
  );
});

test("an async callback and a result that is not an expression are OKM1125", async () => {
  const db = client();
  await refused(
    // @ts-expect-error an async callback returns a promise
    () => db.users.find({ limit: 1, computed: { n: async (u) => u.posts.count() } }),
    "OKM1125",
    "async",
  );
  await refused(
    // @ts-expect-error a number is not an expression
    () => db.users.find({ limit: 1, computed: { n: () => 1 } }),
    "OKM1125",
    "must return an aggregate or a fragment",
  );
  await refused(
    () =>
      db.users.find({
        limit: 1,
        computed: { n: (u) => u.posts.sum(fragment`${u.posts.count()}`) },
      }),
    "OKM1125",
    "not another aggregate",
  );
});

test("sum and avg need a numeric field, and min and max an ordered one", async () => {
  const db = client();
  await refused(
    () => db.users.find({ limit: 1, computed: { n: (u) => u.posts.sum("body" as never) } }),
    "OKM1124",
    "sum and avg",
  );
});

test("a computed value is filtered at the top of where, and a fragment is not a filter", async () => {
  const db = client();
  await refused(
    () =>
      db.users.find({
        limit: 1,
        where: or([{ n: gte(1) }, { name: "x" }]) as never,
        computed: { n: (u) => u.posts.count() },
      }),
    "OKM1120",
    "or() or not()",
  );
  await refused(
    () =>
      db.users.find({
        limit: 1,
        where: { r: gte(1) } as never,
        computed: { r: (u) => fragment`${u.posts.count()} + 1` },
      }),
    "OKM1120",
    "fragment, which is not a filter",
  );
});

test("page() cannot order by a computed value, and an include does not take computed", async () => {
  const db = client();
  const ordered = () =>
    // @ts-expect-error a cursor holds no computed value
    db.users.page({ limit: 2, orderBy: { n: "asc" }, computed: { n: () => fragment`1` } });
  await refused(ordered, "OKM1120", "n");
  await refused(
    () =>
      db.users.find({
        limit: 1,
        // @ts-expect-error an include does not take computed
        include: { posts: { limit: 1, computed: { n: () => fragment`1` } } },
      }),
    "OKM1120",
    "does not take computed",
  );
  await refused(
    () => db.users.find({ limit: 1, computed: {} }),
    "OKM1120",
    "computed must be an object",
  );
});

type Loose = {
  readonly users: { find(options: unknown): PromiseLike<unknown> };
};

function clientFor(
  built: ReturnType<typeof schema>,
  notices: WarningNotice[],
  options?: Parameters<typeof warnings>[0],
): Loose {
  const root = connect(pool, {
    schema: built,
    warnings: warnings({
      env: "development",
      ...options,
      onWarning: (notice) => {
        notices.push(notice);
      },
    }),
  }) as unknown as Loose & { for(scope: object): Loose };
  return built.tenancy === undefined
    ? root
    : root.for({ tenantId: "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c41" });
}

async function notified(
  built: ReturnType<typeof schema>,
  run: (db: Loose) => PromiseLike<unknown>,
  options?: Parameters<typeof warnings>[0],
): Promise<readonly WarningNotice[]> {
  const notices: WarningNotice[] = [];
  await Promise.resolve(run(clientFor(built, notices, options))).catch(() => undefined);
  return notices.filter((notice) => notice.code === "OKM2012");
}

const read = {
  limit: 1,
  orderBy: { id: "asc" },
  computed: { n: (u: { posts: { count(): unknown } }) => u.posts.count() },
};

function build(options: { readonly indexed?: boolean; readonly tenant?: boolean }) {
  const child = table(
    "posts",
    { id: id({ default: "none" }), userId: uuid().references("users"), body: text() },
    options.indexed === true ? { indexes: (columns) => [index(columns.userId)] } : {},
  );
  const parent = table(
    "users",
    { id: id({ default: "none" }), name: text() },
    { relations: { posts: many("posts", "userId") } },
  );
  return schema({
    tables: [parent, child],
    ...(options.tenant === true
      ? { tenancy: columnTenancy({ key: "tenantId", type: "uuid" }) }
      : {}),
  });
}

test("OKM2012 names the index to declare when the foreign key has none", async () => {
  const found = await notified(build({}), (db) => db.users.find(read));
  expect(found).toHaveLength(1);
  const notice = found[0] as WarningNotice;
  expect(notice.level).toBe("hint");
  expect(notice.severity).toBe("low");
  expect(notice.rule).toBe("unindexed-computed-key");
  expect(notice.detail).toBe("posts indexes: (columns) => [index(columns.userId)]");
  expect(notice.docs).toBe("docs/errors/OKM2012.md");
});

test("OKM2012 is silent for a declared index and never blocks the read", async () => {
  expect(await notified(build({ indexed: true }), (db) => db.users.find(read))).toEqual([]);
  expect(await notified(build({ tenant: true }), (db) => db.users.find(read))).toHaveLength(1);
  expect(
    await notified(build({ indexed: true, tenant: true }), (db) => db.users.find(read)),
  ).toEqual([]);
  const thrown = await Promise.resolve(
    clientFor(build({}), []).users.find({ limit: 1, computed: { n: () => fragment`1` } }),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect((thrown as OkmError | undefined)?.code).not.toBe("OKM2012");
});

test("OKM2012 prints the declaration on the console and honors levels", async () => {
  const lines: string[] = [];
  const previous = console.warn;
  console.warn = (...args: readonly unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const db = connect(pool, {
      schema: build({}),
      warnings: warnings({ env: "development" }),
    }) as unknown as Loose;
    await Promise.resolve(db.users.find(read)).catch(() => undefined);
  } finally {
    console.warn = previous;
  }
  const text = lines.find((line) => line.startsWith("OKM2012")) ?? "";
  expect(text).toContain("Declare: posts indexes: (columns) => [index(columns.userId)]");
  expect(text).toContain("Fix:");

  const quiet = await notified(build({}), (db) => db.users.find(read), {
    levels: { "unindexed-computed-key": "off" },
  });
  expect(quiet).toEqual([]);
});
