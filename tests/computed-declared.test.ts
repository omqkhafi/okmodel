/**
 * `schema({ computed })`: declared names, their refusals, and what a
 * declaration does not do. These calls fail, warn, or build the statement
 * before any row is read, so a stub driver is enough.
 */

import { expect, test } from "bun:test";

import { catalogHash, serializeCatalog } from "../src/contracts/catalog/document.js";
import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import {
  id,
  index,
  integer,
  many,
  morph,
  morphMany,
  one,
  schema,
  table,
  text,
  uuid,
} from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";
import { warnings, type WarningNotice } from "../src/runtime/warnings/index.js";

const pool = {
  capabilities: { transactions: "interactive", stream: false, listen: false, cancel: false },
  execute: () => Promise.resolve({ rows: [["170000", "PostgreSQL 17"]], count: 1, notices: [] }),
  batch: () => Promise.resolve([]),
  stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
  close: () => Promise.resolve(),
} as DriverPool;

/** A row as a callback sees it: relations with the aggregate verbs. */
type Row = {
  readonly [relation in "posts" | "owner" | "target"]: Record<
    "count" | "max" | "median",
    (...args: unknown[]) => unknown
  >;
};

type Declared = Record<string, Record<string, unknown>>;

function tables(indexed = false) {
  const posts = table(
    "posts",
    {
      id: id({ default: "none" }),
      userId: uuid().references("users"),
      views: integer().nullable(),
      secret: text().nullable().hidden(),
    },
    {
      relations: { owner: one("users", "userId") },
      ...(indexed ? { indexes: (columns) => [index(columns.userId)] } : {}),
    },
  );
  const pings = table(
    "pings",
    { id: id({ default: "none" }), targetType: text(), targetId: uuid() },
    { relations: { target: morph("target", ["users"]) } },
  );
  const users = table(
    "users",
    { id: id({ default: "none" }), name: text() },
    { relations: { posts: many("posts", "userId"), pings: morphMany("pings", "target") } },
  );
  return [users, posts, pings] as const;
}

function build(computed: Declared, indexed = false) {
  return schema({ tables: tables(indexed), computed: computed as never });
}

const good = { good: (u: { posts: { count(): unknown } }) => u.posts.count() };

function client(built: ReturnType<typeof build>, notices: WarningNotice[] = []) {
  return connect(pool, {
    schema: built,
    warnings: warnings({
      env: "development",
      onWarning: (notice) => {
        notices.push(notice);
      },
    }),
  }) as unknown as {
    readonly users: {
      find(options: unknown): PromiseLike<unknown> & { sql(): PromiseLike<{ text: string }> };
    };
    readonly posts: { find(options: unknown): PromiseLike<unknown> };
    readonly pings: { find(options: unknown): PromiseLike<unknown> };
  };
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
  message: string,
  code = "OKM1120",
): Promise<OkmError> {
  const error = await refusal(run);
  expect(error.code).toBe(code);
  expect(error.message).toContain(message);
  expect(error.fix?.summary.length ?? 0).toBeGreaterThan(0);
  return error;
}

test("true on a name nothing declared is refused and lists the declared names", async () => {
  const db = client(build({ users: good }));
  const error = await refused(
    () => db.users.find({ limit: 1, computed: { nope: true } }),
    "computed.nope is not declared on users. Declared: good.",
  );
  expect(error.fix?.summary).toContain("schema({ computed })");
  const bare = client(schema({ tables: tables() }));
  await refused(
    () => bare.users.find({ limit: 1, computed: { nope: true } }),
    "computed.nope is not declared on users. Declared: (none).",
  );
  const other = client(build({ posts: { views2: (p: never) => p } }));
  await refused(
    () => other.users.find({ limit: 1, computed: { views2: true } }),
    "computed.views2 is not declared on users",
  );
});

test("a callback under a declared name is refused, and so is a value that is not true", async () => {
  const db = client(build({ users: good }));
  const error = await refused(
    () => db.users.find({ limit: 1, computed: { good: (u: never) => u } }),
    "computed name good is already declared on users. Declared: good.",
  );
  expect(error.fix?.summary).toContain("computed: { good: true }");
  for (const value of [false, 1, "good", null]) {
    await refused(
      () => db.users.find({ limit: 1, computed: { other: value } }),
      "must be a function of the row, or true for a declared name",
    );
  }
});

test("a declared name that is a field, a relation, or a prototype key is refused on first read", async () => {
  const withName = (name: string) =>
    client(build({ users: Object.fromEntries([[name, () => undefined]]) }));
  await refused(
    () => withName("name").users.find({ limit: 1, computed: { x: true } }),
    "computed name name is already a field",
  );
  await refused(
    () => withName("posts").users.find({ limit: 1, computed: { x: true } }),
    "computed name posts is already a relation",
  );
  await refused(
    () => withName("__proto__").users.find({ limit: 1, computed: { x: true } }),
    "__proto__",
  );
});

test("a declared table that is not in the schema is refused and lists the tables", async () => {
  const db = client(build({ user: good }));
  await refused(
    () => db.users.find({ limit: 1, computed: { good: true } }),
    "computed declares values for user, which is not a table of this schema. Accepted names: users, posts, pings.",
  );
});

test("a declaration is checked when selected, with the same refusals as an ad hoc callback", async () => {
  const cases: readonly (readonly [string, Declared, string, string?])[] = [
    ["hidden field", { users: { bad: (u: Row) => u.posts.max("secret") } }, "is hidden"],
    ["one relation", { posts: { bad: (p: Row) => p.owner.count() } }, "is a one relation"],
    ["morph relation", { pings: { bad: (p: Row) => p.target.count() } }, "morph relation"],
    [
      "unknown verb",
      { users: { bad: (u: Row) => u.posts.median("views") } },
      "not a computed verb",
    ],
    [
      "unknown field",
      { users: { bad: (u: Row) => u.posts.max("nope") } },
      "Field nope is not on posts",
    ],
    [
      "unknown where field",
      { users: { bad: (u: Row) => u.posts.count({ where: { nope: 1 } }) } },
      "nope",
    ],
    [
      "async function",
      { users: { bad: async (u: Row) => u.posts.count() } },
      "cannot be an async function",
      "OKM1125",
    ],
  ];
  for (const [label, declared, message, code] of cases) {
    const own = Object.keys(declared)[0] as "users" | "posts" | "pings";
    const db = client(build({ ...declared, users: { ...declared.users, ...good } }));
    const read = { limit: 1, computed: { bad: true } };
    const error = await refusal(() => db[own].find(read));
    expect(error.code, label).toBe(code ?? "OKM1120");
    expect(error.message, label).toContain(message);
    if (own === "users") {
      const text = (await db.users.find({ limit: 1, computed: { good: true } }).sql()).text;
      expect(text, label).toContain("left join (select");
    }
  }
});

test("a callback is stored as given and runs only when a read selects it", async () => {
  const runs: string[] = [];
  const spy = (name: string) => (u: { posts: { count(): unknown } }) => {
    runs.push(name);
    return u.posts.count();
  };
  const built = build({ users: { first: spy("first"), second: spy("second") } });
  expect(runs).toEqual([]);
  const stored = (built as unknown as { computed: Declared }).computed;
  expect(Object.keys(stored.users ?? {})).toEqual(["first", "second"]);
  const db = client(built);
  expect(runs).toEqual([]);
  await db.users.find({ limit: 1, computed: { first: true } }).sql();
  expect(runs).toEqual(["first"]);
});

test("the table option stays OKM1061 and points at schema({ computed })", () => {
  let error: unknown;
  try {
    table("tasks", { id: id({ default: "none" }) }, { computed: { label: true } } as never);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(OkmError);
  expect((error as OkmError).code).toBe("OKM1061");
  expect((error as OkmError).message).toContain("Declare it in schema({ computed })");
});

test("a declaration is not a catalog object", () => {
  const plain = schema({ tables: tables() });
  const declared = build({ users: good, posts: { n: (p: never) => p } });
  expect(declared.catalog).toBeDefined();
  expect(serializeCatalog(declared.catalog)).toBe(serializeCatalog(plain.catalog));
  expect(catalogHash(declared.catalog)).toBe(catalogHash(plain.catalog));
});

async function notified(built: ReturnType<typeof build>): Promise<readonly WarningNotice[]> {
  const notices: WarningNotice[] = [];
  await Promise.resolve(
    client(built, notices).users.find({ limit: 1, computed: { good: true } }),
  ).catch(() => undefined);
  return notices.filter((notice) => notice.code === "OKM2012");
}

test("OKM2012 reports an unindexed key for a declared value, and stays silent when indexed", async () => {
  const found = await notified(build({ users: good }));
  expect(found).toHaveLength(1);
  const notice = found[0] as WarningNotice;
  expect(notice.rule).toBe("unindexed-computed-key");
  expect(notice.detail).toBe("posts indexes: (columns) => [index(columns.userId)]");
  expect(await notified(build({ users: good }, true))).toEqual([]);
});
