/**
 * Schema rules OKM2101, OKM2102, and OKM2103.
 *
 * Each rule has a positive case and nearby schemas that must stay silent. A
 * rule that cannot decide (an expression index, a preset that needs its
 * arguments, a `filters()` field that is not a literal) never fires.
 */

import { expect, test } from "bun:test";

import type { Catalog } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { index, or, schema, table, t } from "../src/dialects/pg/index.js";
import { stampOwnership } from "../src/dialects/pg/owner.js";
import { columnTenancy, global } from "../src/runtime/tenancy/index.js";
import { discoverFilterUses, type FilterUse } from "../src/tooling/migrate/filter-scan.js";
import {
  adviceRefusal,
  schemaAdvice,
  type SchemaAdviceConfig,
  type SchemaAdviceInput,
} from "../src/tooling/migrate/schema-rules.js";

const users = () => table("users", { id: t.identity(), email: t.text() });

function codes(
  input: SchemaAdviceInput,
  uses: readonly FilterUse[] = [],
  config: SchemaAdviceConfig = {},
): readonly string[] {
  return schemaAdvice(input, uses, config).advice.map((item) => `${item.code} ${item.target}`);
}

function withExpression(input: SchemaAdviceInput, table: string): SchemaAdviceInput {
  const catalog: Catalog = {
    ...input.catalog,
    objects: input.catalog.objects.map((object) =>
      object.kind === "index" && object.identity.parent.name === table
        ? { ...object, definition: { ...object.definition, expression: "lower(x)" } }
        : object,
    ),
  };
  return { ...input, catalog };
}

test("OKM2101 fires for a foreign key with no index and names the columns", () => {
  const built = schema({
    casing: "snake",
    tables: [
      users(),
      table("posts", { id: t.identity(), authorId: t.bigint().references("users") }),
    ],
  });
  expect(codes(built)).toEqual(["OKM2101 posts.author_id"]);
  const [advice] = schemaAdvice(built, [], {}).advice;
  expect(advice?.level).toBe("warn");
  expect(advice?.severity).toBe("medium");
  expect(advice?.reason).toContain("posts (author_id) references users (id)");
});

test("OKM2101 fires when the key column is not the first index column", () => {
  const built = schema({
    tables: [
      users(),
      table(
        "posts",
        { id: t.identity(), createdAt: t.text(), authorId: t.bigint().references("users") },
        { indexes: (columns) => [index(columns.createdAt, columns.authorId)] },
      ),
    ],
  });
  expect(codes(built)).toEqual(["OKM2101 posts.authorId"]);
});

test("OKM2101 stays silent when an index, a composite index, a unique, or the key covers the columns", () => {
  const plain = schema({
    tables: [
      users(),
      table(
        "posts",
        { id: t.identity(), authorId: t.bigint().references("users") },
        { indexes: (columns) => [index(columns.authorId)] },
      ),
    ],
  });
  expect(codes(plain)).toEqual([]);

  const composite = schema({
    tables: [
      users(),
      table(
        "posts",
        { id: t.identity(), authorId: t.bigint().references("users"), createdAt: t.text() },
        { indexes: (columns) => [index(columns.authorId, columns.createdAt)] },
      ),
    ],
  });
  expect(codes(composite)).toEqual([]);

  const unique = schema({
    tables: [
      users(),
      table(
        "profiles",
        { id: t.identity(), userId: t.bigint().references("users") },
        { indexes: (columns) => [index(columns.userId).unique()] },
      ),
    ],
  });
  expect(codes(unique)).toEqual([]);

  const inKey = schema({
    tables: [
      users(),
      table("teams", { id: t.identity() }),
      table(
        "members",
        {
          userId: t.bigint().references("users"),
          teamId: t.bigint().references("teams"),
        },
        { primaryKey: ["userId", "teamId"] },
      ),
    ],
  });
  expect(codes(inKey)).toEqual(["OKM2101 members.teamId"]);
});

test("OKM2101 accepts the tenant-first index for a composite tenant key", () => {
  const tenancy = columnTenancy({ key: "tenantId", type: "uuid" });
  const posts = (indexed: boolean) =>
    schema({
      casing: "snake",
      tenancy,
      tables: [
        table("users", { id: t.identity() }),
        table(
          "posts",
          { id: t.identity(), authorId: t.bigint().references("users") },
          indexed ? { indexes: (columns) => [index(columns.authorId)] } : {},
        ),
      ],
    });
  expect(codes(posts(false))).toEqual(["OKM2101 posts.author_id,tenant_id"]);
  expect(codes(posts(true))).toEqual([]);
});

test("OKM2101 stays silent for a column an expression index names", () => {
  const built = schema({
    tables: [
      users(),
      table(
        "posts",
        { id: t.identity(), authorId: t.bigint().references("users") },
        { indexes: (columns) => [index(columns.authorId)] },
      ),
    ],
  });
  const bare = schema({
    tables: [
      users(),
      table("posts", { id: t.identity(), authorId: t.bigint().references("users") }),
    ],
  });
  expect(codes(withExpression(built, "posts"))).toEqual([]);
  expect(codes(bare)).toEqual(["OKM2101 posts.authorId"]);
});

test("OKM2102 fires for a table with no primary key, even one with a unique index", () => {
  const built = schema({
    tables: [
      table("events", { name: t.text() }),
      table("tags", { name: t.text() }, { indexes: (columns) => [index(columns.name).unique()] }),
    ],
  });
  expect(codes(built)).toEqual(["OKM2102 events", "OKM2102 tags"]);
});

test("OKM2102 stays silent with a primary key and for an external table", () => {
  expect(codes(schema({ tables: [users()] }))).toEqual([]);
  expect(
    codes(
      schema({
        tables: [table("keyed", { code: t.text(), n: t.bigint() }, { primaryKey: ["code", "n"] })],
      }),
    ),
  ).toEqual([]);
  const keyless = schema({ tables: [table("legacy", { name: t.text() })] });
  const external = stampOwnership(keyless.catalog, new Map([["legacy", "external"]]));
  expect(codes({ ...keyless, catalog: external })).toEqual([]);
});

test("OKM2103 fires for a preset column with no index", () => {
  const built = schema({
    casing: "snake",
    tables: [
      table(
        "tasks",
        { id: t.identity(), dueAt: t.text(), status: t.text() },
        {
          presets: { pending: (q) => q.where({ status: "pending" }) },
        },
      ),
    ],
  });
  expect(codes(built)).toEqual(["OKM2103 tasks.status"]);
  const [advice] = schemaAdvice(built, [], {}).advice;
  expect(advice?.reason).toContain("preset pending");
});

test("OKM2103 reads an or() preset and ignores relation names and unknown fields", () => {
  const built = schema({
    tables: [
      table(
        "tasks",
        { id: t.identity(), status: t.text(), kind: t.text() },
        {
          presets: {
            open: (q) => q.where(or([{ status: "a" }, { kind: "b" }])),
            odd: (q) => q.where({ nothing: 1 } as never),
          },
        },
      ),
    ],
  });
  expect(codes(built)).toEqual(["OKM2103 tasks.kind", "OKM2103 tasks.status"]);
});

test("OKM2103 stays silent when an index, the key, or a unique starts with the column", () => {
  const indexed = schema({
    tables: [
      table(
        "tasks",
        { id: t.identity(), status: t.text() },
        {
          presets: { pending: (q) => q.where({ status: "pending" }) },
          indexes: (columns) => [index(columns.status)],
        },
      ),
    ],
  });
  expect(codes(indexed)).toEqual([]);

  const byKey = schema({
    tables: [
      table(
        "tasks",
        { id: t.identity(), status: t.text() },
        {
          presets: { byId: (q) => q.where({ id: "1" }) },
        },
      ),
    ],
  });
  expect(codes(byKey)).toEqual([]);

  const unique = schema({
    tables: [
      table(
        "tasks",
        { id: t.identity(), slug: t.text() },
        {
          presets: { named: (q) => q.where({ slug: "x" }) },
          indexes: (columns) => [index(columns.slug).unique()],
        },
      ),
    ],
  });
  expect(codes(unique)).toEqual([]);
});

test("OKM2103 fires when the column is only the second index column", () => {
  const built = schema({
    tables: [
      table(
        "tasks",
        { id: t.identity(), team: t.text(), status: t.text() },
        {
          presets: { pending: (q) => q.where({ status: "pending" }) },
          indexes: (columns) => [index(columns.team, columns.status)],
        },
      ),
    ],
  });
  expect(codes(built)).toEqual(["OKM2103 tasks.status"]);
});

test("OKM2103 counts the tenant prefix OKModel adds, on a tenant table only", () => {
  const tenancy = columnTenancy({ key: "tenantId", type: "uuid" });
  const tenant = schema({
    casing: "snake",
    tenancy,
    tables: [
      table(
        "tasks",
        { id: t.identity(), status: t.text(), owner: t.text() },
        {
          presets: {
            pending: (q) => q.where({ status: "pending" }),
            mine: (q) => q.where({ owner: "x" }),
          },
          indexes: (columns) => [index(columns.status)],
        },
      ),
    ],
  });
  expect(codes(tenant)).toEqual(["OKM2103 tasks.owner"]);

  const shared = schema({
    casing: "snake",
    tenancy,
    tables: [
      table(
        "countries",
        { id: t.identity(), name: t.text(), code: t.text() },
        {
          tenancy: global("shared"),
          presets: { named: (q) => q.where({ name: "x" }) },
          indexes: (columns) => [index(columns.code, columns.name)],
        },
      ),
    ],
  });
  expect(codes(shared)).toEqual(["OKM2103 countries.name"]);
});

test("OKM2103 stays silent for an expression index on the column", () => {
  const built = schema({
    tables: [
      table(
        "tasks",
        { id: t.identity(), status: t.text() },
        {
          presets: { pending: (q) => q.where({ status: "pending" }) },
          indexes: (columns) => [index(columns.status)],
        },
      ),
    ],
  });
  expect(codes(withExpression(built, "tasks"))).toEqual([]);
});

test("OKM2103 stays silent for a preset that needs its arguments", () => {
  const built = schema({
    tables: [
      table(
        "tasks",
        { id: t.identity(), status: t.text() },
        {
          presets: {
            since: ((q: { where(filter: unknown): unknown }, from: { at: string }) =>
              q.where({ status: from.at })) as never,
          },
        },
      ),
    ],
  });
  expect(codes(built)).toEqual([]);
});

const routes = `
import { table, text, identity } from "okmodel/pg";
const notes = table("notes", { id: identity(), title: text(), rank: text() });
const other = (x: number) => x;
export const noteFilters = notes.filters({
  allow: { title: ["eq", "startsWith"], rank: ["gt"] },
  sort: ["rank"],
});
`;

test("filters() fields come from literal allow keys and sort strings", () => {
  const uses = discoverFilterUses([{ path: "src/routes.ts", text: routes }]);
  expect(uses.map((use) => `${use.table}.${use.field}:${use.list}`)).toEqual([
    "notes.title:allow",
    "notes.rank:allow",
    "notes.rank:sort",
  ]);
  expect(uses[0]?.file).toBe("src/routes.ts");
  expect(uses[0]?.line).toBe(5);
});

test("OKM2103 fires for filters() allow and sort fields with no index", () => {
  const built = schema({
    tables: [table("notes", { id: t.identity(), title: t.text(), rank: t.text() })],
  });
  const uses = discoverFilterUses([{ path: "src/routes.ts", text: routes }]);
  expect(codes(built, uses)).toEqual(["OKM2103 notes.rank", "OKM2103 notes.title"]);
  const [second, first] = schemaAdvice(built, uses, {}).advice;
  expect(first?.reason).toContain("the filters() allow list");
  expect(second?.reason).toContain("the filters() allow list, the filters() sort list");
  expect(first?.location).toEqual({ file: "src/routes.ts", line: 5 });
});

test("OKM2103 stays silent when the filtered columns are indexed", () => {
  const built = schema({
    tables: [
      table(
        "notes",
        { id: t.identity(), title: t.text(), rank: t.text() },
        { indexes: (columns) => [index(columns.title), index(columns.rank)] },
      ),
    ],
  });
  const uses = discoverFilterUses([{ path: "src/routes.ts", text: routes }]);
  expect(codes(built, uses)).toEqual([]);
});

test("filters() reads nothing it cannot decide", () => {
  const source = `
    import { table as makeTable } from "okmodel/pg";
    const notes = makeTable("notes", {});
    const dynamic = { title: ["eq"] };
    const key = "rank";
    notes.filters({ allow: { ...dynamic, [key]: ["eq"] }, sort: [key] });
    notes.filters(spec);
    notes.filters({ allow, sort: ["a" as const] });
    stranger.filters({ allow: { title: ["eq"] } });
    app.notes.filters({ allow: { title: ["eq"] } });
    // notes.filters({ allow: { title: ["eq"] } });
    const text = "notes.filters({ allow: { title: [] } })";
  `;
  expect(discoverFilterUses([{ path: "src/a.ts", text: source }])).toEqual([]);
});

test("a name bound to two tables is not read", () => {
  const files = [
    { path: "a.ts", text: 'import { table } from "x";\nconst rows = table("a", {});\n' },
    {
      path: "b.ts",
      text: 'import { table } from "x";\nconst rows = table("b", {});\nrows.filters({ allow: { n: ["eq"] } });\n',
    },
  ];
  expect(discoverFilterUses(files)).toEqual([]);
});

test("levels, ignore, and target shape what is reported", () => {
  const built = schema({
    tables: [
      users(),
      table("posts", { id: t.identity(), authorId: t.bigint().references("users") }),
      table("events", { name: t.text() }),
    ],
  });
  expect(codes(built)).toEqual(["OKM2101 posts.authorId", "OKM2102 events"]);
  expect(
    codes(built, [], {
      levels: { "unindexed-foreign-key": "off", "table-without-primary-key": "hint" },
    }),
  ).toEqual(["OKM2102 events"]);
  const hinted = schemaAdvice(built, [], { levels: { "table-without-primary-key": "hint" } });
  expect(hinted.advice.find((item) => item.code === "OKM2102")?.level).toBe("hint");

  const byRule = schemaAdvice(built, [], {
    ignore: [{ rule: "table-without-primary-key", reason: "append-only log" }],
  });
  expect(byRule.advice.map((item) => item.code)).toEqual(["OKM2101"]);
  expect(byRule.ignores).toEqual([
    { rule: "table-without-primary-key", reason: "append-only log", status: "applied" },
  ]);

  const byTable = schemaAdvice(built, [], {
    ignore: [
      { rule: "table-without-primary-key", target: "events", reason: "log" },
      { rule: "unindexed-foreign-key", target: "posts.authorId", reason: "tiny table" },
    ],
  });
  expect(byTable.advice).toEqual([]);
  expect(byTable.ignores.map((item) => item.status)).toEqual(["applied", "applied"]);

  const byParent = schemaAdvice(built, [], {
    ignore: [{ rule: "unindexed-foreign-key", target: "posts", reason: "whole table" }],
  });
  expect(byParent.advice.map((item) => item.code)).toEqual(["OKM2102"]);
});

test("an ignore that matched nothing is stale, and other rules carry no status", () => {
  const built = schema({ tables: [users()] });
  const result = schemaAdvice(built, [], {
    ignore: [
      { rule: "table-without-primary-key", target: "events", reason: "gone" },
      { rule: "unindexed-foreign-key", reason: "never needed" },
      { rule: "deep-offset", reason: "runtime rule" },
      { rule: "future-rule", reason: "unknown id" },
    ],
  });
  expect(result.ignores.map((item) => item.status)).toEqual([
    "stale",
    "stale",
    undefined,
    undefined,
  ]);
});

test("an ignore stays applied when its rule is turned off", () => {
  const built = schema({ tables: [table("events", { name: t.text() })] });
  const result = schemaAdvice(built, [], {
    levels: { "table-without-primary-key": "off" },
    ignore: [{ rule: "table-without-primary-key", reason: "log" }],
  });
  expect(result.advice).toEqual([]);
  expect(result.ignores[0]?.status).toBe("applied");
});

test("level error refuses with the rule code and every error line", () => {
  const built = schema({
    tables: [
      users(),
      table("posts", { id: t.identity(), authorId: t.bigint().references("users") }),
      table("events", { name: t.text() }),
    ],
  });
  const { advice } = schemaAdvice(built, [], {
    levels: { "unindexed-foreign-key": "error", "table-without-primary-key": "error" },
  });
  const refusal = adviceRefusal(advice);
  expect(refusal).toBeInstanceOf(OkmError);
  expect(refusal?.code).toBe("OKM2101");
  expect(refusal?.message).toContain("OKM2101 posts.authorId");
  expect(refusal?.message).toContain("OKM2102 events");
  expect(adviceRefusal(schemaAdvice(built, [], {}).advice)).toBeUndefined();
});
