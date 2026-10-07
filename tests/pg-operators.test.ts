/**
 * Tagged operators for json, arrays, ranges, and tsvector (spec §10.1).
 *
 * Values are parameters. A key, path, or regconfig that cannot be bound fails
 * before a statement exists. JSON cannot forge an operator.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import {
  arr,
  contains,
  containedBy,
  eq,
  gt,
  hasAnyKey,
  hasKey,
  id,
  int4range,
  integer,
  json,
  jsonb,
  matches,
  overlaps,
  path,
  schema,
  t,
  table,
  text,
  tsvector,
} from "../src/dialects/pg/index.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";

const ID = "11111111-1111-4111-8111-111111111111";

const docs = table("docs", {
  id: id(),
  title: text(),
  tags: text().array(),
  meta: jsonb<{ readonly published: boolean; readonly title: string }>(),
  doc: t.json<{ readonly title: string }>(),
  span: int4range(),
  body: tsvector(),
  count: integer(),
});

const app = schema({ casing: "snake", tables: [docs] });

const DDL = `create table docs (
  id uuid primary key,
  title text not null,
  tags text[] not null,
  meta jsonb not null,
  doc json not null,
  span int4range not null,
  body tsvector not null,
  count integer not null
)`;

const SEED = `insert into docs (id, title, tags, meta, doc, span, body, count) values (
  '${ID}',
  'ship',
  '{news,draft}',
  '{"published":true,"title":"a"}',
  '{"title":"a"}',
  '[1,10)',
  to_tsvector('english', 'ship the model'),
  3
)`;

const span = {
  empty: false as const,
  lower: 1,
  upper: 10,
  lowerInclusive: true,
  upperInclusive: false,
};

type Client = Awaited<ReturnType<typeof connectPglite<typeof app>>>;
type SqlText = { readonly text: string; readonly params: readonly (string | null)[] };

function stub(): DriverPool {
  return {
    capabilities: {
      transactions: "interactive",
      stream: false,
      listen: false,
      cancel: false,
      prepared: "unnamed",
      describe: false,
    },
    execute: () =>
      Promise.resolve({ rows: [["170000", "PostgreSQL 17", null]], count: 1, notices: [] }),
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
}

async function described(db: Client, where: unknown): Promise<SqlText> {
  return db.docs.find({ where: where as { readonly id: string }, limit: 1 }).sql();
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof OkmError ? error.code : "other";
  }
  return "none";
}

const safeText = fc.string({ minLength: 1, maxLength: 24 }).filter((value) => {
  if (value.includes("\\") || value.includes('"')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
});

test("containment, keys, paths, and matches are parameters", async () => {
  const db = await connectPglite(stub(), { schema: app });
  const meta = await described(db, { meta: contains({ published: true }) });
  expect(meta.text).toContain(`t."meta" @> $1::jsonb`);
  expect(meta.params[0]).toBe('{"published":true}');
  expect(meta.text.includes("published")).toBe(false);

  const tags = await described(db, { tags: contains(["news"]) });
  expect(tags.text).toContain(`t."tags" @> $1::text[]`);
  expect(tags.params[0]).toContain("news");

  const inside = await described(db, { tags: containedBy(["news", "draft", "extra"]) });
  expect(inside.text).toContain(`t."tags" <@ $1::text[]`);

  const shared = await described(db, { tags: overlaps(["other", "news"]) });
  expect(shared.text).toContain(`t."tags" && $1::text[]`);

  const range = await described(db, { span: overlaps(span) });
  expect(range.text).toContain(`t."span" && $1::int4range`);
  expect(range.params[0]).toBe("[1,10)");

  const key = await described(db, { meta: hasKey("published") });
  expect(key.text).toContain(`jsonb_exists(t."meta", $1)`);
  expect(key.text.includes("?")).toBe(false);
  expect(key.params[0]).toBe("published");

  const keys = await described(db, { meta: hasAnyKey(["missing", "published"]) });
  expect(keys.text).toContain(`jsonb_exists_any(t."meta", $1::text[])`);
  expect(keys.params[0]).toContain("published");

  const nested = await described(db, { meta: path(["title"], eq("a")) });
  expect(nested.text).toContain(`(t."meta" #>> $1::text[])::text = $2`);
  expect(nested.params[1]).toBe("a");

  const numeric = await described(db, { count: gt(1), meta: path(["n"], gt(2)) });
  expect(numeric.text).toContain(`::numeric > $`);

  const flag = await described(db, { meta: path(["published"], eq(true)) });
  expect(flag.text).toContain(`::boolean = $`);
  expect(flag.params).toContain("true");

  const search = await described(db, { body: matches("ship the") });
  expect(search.text).toContain(`t."body" @@ websearch_to_tsquery($1)`);
  expect(search.params[0]).toBe("ship the");

  const plain = await described(db, {
    body: matches("ship", { mode: "plain", config: "english" }),
  });
  expect(plain.text).toContain(`plainto_tsquery($1::regconfig, $2)`);
  expect(plain.params[0]).toBe("english");
  expect(plain.params[1]).toBe("ship");
  expect(plain.text.includes("english")).toBe(false);

  const phrase = await described(db, { body: matches("ship the", { mode: "phrase" }) });
  expect(phrase.text).toContain("phraseto_tsquery($1)");

  const title = await described(db, { title: contains("hip") });
  expect(title.text).toContain(" like ");
  expect(title.params[0]).toBe("%hip%");

  const written = await db.docs
    .update({
      where: { id: ID },
      set: { meta: json.set(["published"], false), tags: arr.append("late") },
    })
    .sql();
  const update = written.statements[0];
  expect(update?.text).toContain(`jsonb_set(t."meta", $1::text[], $2::jsonb)`);
  expect(update?.text).toContain(`array_append(t."tags", $3::text)`);
  expect(update?.params?.[0]).toContain("published");
  expect(update?.params?.[1]).toBe("false");
  expect(update?.params?.[2]).toBe("late");
  expect(update?.text.includes("published")).toBe(false);

  const removed = await db.docs
    .update({ where: { id: ID }, set: { tags: arr.remove("draft") } })
    .sql();
  expect(removed.statements[0]?.text).toContain(`array_remove(t."tags", $1::text)`);

  const jsonColumn = await db.docs
    .update({ where: { id: ID }, set: { doc: json.set(["title"], "b") } })
    .sql();
  expect(jsonColumn.statements[0]?.text).toContain(
    `jsonb_set(t."doc"::jsonb, $1::text[], $2::jsonb)::json`,
  );
  await db.close();
});

test("an operator that does not fit the column is OKM1124 and does not run", async () => {
  const calls: string[] = [];
  const pool = stub();
  pool.execute = (text) => {
    calls.push(text);
    return Promise.resolve({ rows: [["170000", "PostgreSQL 17", null]], count: 1, notices: [] });
  };
  const db = await connectPglite(pool, { schema: app });
  await db.connected;
  calls.length = 0;

  let thrown: unknown;
  try {
    await db.docs.find({
      where: { count: contains(1) } as unknown as { readonly id: string },
      limit: 1,
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ code: "OKM1124" });
  expect(calls).toEqual([]);

  const count = (where: unknown): Promise<SqlText> => described(db, where);
  expect(await codeOf(() => count({ count: contains(1) }))).toBe("OKM1124");
  try {
    await count({ count: contains(1) });
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.message).toContain("integer");
      expect(error.message).toContain("count");
      expect(error.message).toContain("eq, not, lt, lte, gt, gte, between, inList, notIn, inc");
    }
  }
  expect(await codeOf(() => count({ title: matches("ship") }))).toBe("OKM1124");
  try {
    await count({ title: matches("ship") });
  } catch (error) {
    if (error instanceof OkmError) {
      expect(error.message).toContain("text column title");
      expect(error.message).toContain("Text search needs a tsvector column.");
    }
  }
  expect(await codeOf(() => count({ doc: hasKey("title") }))).toBe("OKM1124");
  expect(await codeOf(() => count({ meta: overlaps({ published: true }) }))).toBe("OKM1124");
  expect(await codeOf(() => count({ body: contains("ship") }))).toBe("OKM1124");
  expect(calls).toEqual([]);
  await db.close();
});

test("hostile keys, paths, and configs fail or stay parameters", async () => {
  const db = await connectPglite(stub(), { schema: app });
  const hostile = `'; drop table docs; --`;

  const key = await described(db, { meta: hasKey(hostile) });
  expect(key.text.includes(hostile)).toBe(false);
  expect(key.text.includes(";")).toBe(false);
  expect(key.params[0]).toBe(hostile);

  const segments = await described(db, { meta: path([hostile], eq("a")) });
  expect(segments.text.includes(hostile)).toBe(false);
  expect(segments.text.includes(";")).toBe(false);
  expect(segments.params[0]).toContain(hostile);

  const query = await described(db, { body: matches(hostile) });
  expect(query.text).toContain("websearch_to_tsquery($1)");
  expect(query.text.includes(hostile)).toBe(false);
  expect(query.params[0]).toBe(hostile);

  expect(await codeOf(() => described(db, { meta: hasKey("") }))).toBe("OKM1122");
  expect(await codeOf(() => described(db, { meta: hasKey("a\u0000b") }))).toBe("OKM1122");
  expect(await codeOf(() => described(db, { meta: path(["a\nb"], eq("a")) }))).toBe("OKM1122");
  expect(await codeOf(() => described(db, { body: matches("ship\u0000") }))).toBe("OKM1122");
  expect(
    await codeOf(() => described(db, { body: matches("ship", { config: "english; drop" }) })),
  ).toBe("OKM1122");
  expect(
    await codeOf(() =>
      described(db, { body: matches("ship", { mode: "websearch", config: "a b" }) }),
    ),
  ).toBe("OKM1122");

  const forged: unknown = JSON.parse(JSON.stringify(contains({ published: true })));
  expect(await codeOf(() => described(db, { meta: forged }))).toBe("OKM1121");
  expect(await codeOf(() => described(db, { meta: { published: true } }))).toBe("OKM1121");
  await db.close();
});

test("request text never becomes SQL", async () => {
  const db = await connectPglite(stub(), { schema: app });
  await fc.assert(
    fc.asyncProperty(safeText, async (raw) => {
      const marker = `HST_${raw}`;
      const key = await described(db, { meta: hasKey(marker) });
      expect(key.text.includes(marker)).toBe(false);
      expect(key.params).toContain(marker);
      const nested = await described(db, { meta: path([marker], eq("1")) });
      expect(nested.text.includes(marker)).toBe(false);
      expect(nested.params.some((param) => param?.includes(marker))).toBe(true);
      const search = await described(db, {
        body: matches(marker, { config: "pg_catalog.simple" }),
      });
      expect(search.text.includes(marker)).toBe(false);
      expect(search.text.includes("pg_catalog.simple")).toBe(false);
      expect(search.params[0]).toBe("pg_catalog.simple");
      expect(search.params[1]).toBe(marker);
    }),
    { numRuns: 30 },
  );
  await db.close();
});

async function behavior(db: Client): Promise<void> {
  const published = await db.docs.find({
    where: { meta: contains({ published: true }) },
    limit: 5,
  });
  expect(published.map((row) => row.id)).toEqual([ID]);

  const tagged = await db.docs.find({
    where: { tags: contains(["news"]), span: overlaps(span) },
    limit: 5,
  });
  expect(tagged.map((row) => row.title)).toEqual(["ship"]);

  const held = await db.docs.find({
    where: { tags: containedBy(["news", "draft", "extra"]) },
    limit: 5,
  });
  expect(held).toHaveLength(1);

  const keyed = await db.docs.find({
    where: { meta: hasKey("published"), body: matches("ship") },
    limit: 5,
  });
  expect(keyed).toHaveLength(1);

  const titled = await db.docs.find({
    where: { doc: path(["title"], eq("a")) },
    limit: 5,
  });
  expect(titled).toHaveLength(1);

  const missed = await db.docs.find({ where: { body: matches("zzzz") }, limit: 5 });
  expect(missed).toEqual([]);

  await db.docs.update({
    where: { id: ID },
    set: { tags: arr.append("late"), meta: json.set(["draft"], false) },
  });
  const next = await db.docs.find({ where: { id: ID }, limit: 1 });
  expect(next[0]?.tags).toEqual(["news", "draft", "late"]);
  const meta: unknown = next[0]?.meta;
  expect(meta).toEqual({ published: true, title: "a", draft: false });

  await db.docs.update({ where: { id: ID }, set: { tags: arr.remove("draft") } });
  const removed = await db.docs.find({ where: { tags: contains(["late"]) }, limit: 1 });
  expect(removed[0]?.tags).toEqual(["news", "late"]);
}

test("operators match on pglite", async () => {
  const pool = await openPglite();
  try {
    await pool.execute(DDL);
    await pool.execute(SEED);
    const db = await connectPglite(pool, { schema: app });
    await behavior(db);
    await db.close();
  } finally {
    await pool.close();
  }
}, 15_000);

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "operators match on postgres",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(DDL);
      await sql.unsafe(SEED);
      const pool = openPostgres({ url: primaryUrl(), searchPath: schemaName });
      try {
        const db = connectPostgres(pool, { schema: app });
        await behavior(db);
        await db.close();
      } finally {
        await pool.close();
      }
    });
  },
  15_000,
);
