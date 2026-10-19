/**
 * `search` compiles to the same SQL as `matches` and `relevance`.
 *
 * Errors name the columns you can search. `page` refuses `search`.
 */

import { expect, test } from "bun:test";

import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { id, matches, relevance, schema, table, text, tsvector } from "../src/dialects/pg/index.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";

const pages = table("pages", {
  id: id({ default: "none" }),
  title: text(),
  body: tsvector(),
});

const notes = table("notes", {
  id: id({ default: "none" }),
  title: text(),
  body: tsvector(),
  titleDoc: tsvector(),
});

const tags = table("tags", {
  id: id({ default: "none" }),
  name: text(),
});

const app = schema({ casing: "snake", tables: [pages, notes, tags] });

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

async function sql(query: { sql(): SqlText | Promise<SqlText> }): Promise<SqlText> {
  return query.sql();
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof OkmError ? error.code : "other";
  }
  return "none";
}

test("search compiles to matches plus relevance", async () => {
  const db = await connectPglite(stub(), { schema: app });

  const found = await sql(db.pages.find({ search: "deploy rollback", limit: 5 }));
  const manual = await sql(
    db.pages.find({
      where: { body: matches("deploy rollback") },
      orderBy: { body: relevance("deploy rollback"), id: "asc" },
      limit: 5,
    }),
  );
  expect(found).toEqual(manual);
  expect(found.text).toContain(`t."body" @@ websearch_to_tsquery($1)`);
  expect(found.text).toContain(
    `order by ts_rank(t."body", websearch_to_tsquery($2)) desc, t."id" asc nulls last`,
  );
  expect(found.params).toEqual(["deploy rollback", "deploy rollback", "5"]);

  const filtered = await sql(
    db.pages.find({ search: "deploy", where: { title: "b" }, select: ["id"], limit: 5 }),
  );
  const filteredManual = await sql(
    db.pages.find({
      where: { title: "b", body: matches("deploy") },
      select: ["id"],
      orderBy: { body: relevance("deploy"), id: "asc" },
      limit: 5,
    }),
  );
  expect(filtered).toEqual(filteredManual);

  const ordered = await sql(
    db.pages.find({ search: "deploy", orderBy: { title: "asc" }, limit: 5 }),
  );
  const orderedManual = await sql(
    db.pages.find({
      where: { body: matches("deploy") },
      orderBy: { title: "asc" },
      limit: 5,
    }),
  );
  expect(ordered).toEqual(orderedManual);
  expect(ordered.text.includes("ts_rank")).toBe(false);

  const counted = await sql(db.pages.count({ search: "deploy" }));
  const countedManual = await sql(db.pages.count({ where: { body: matches("deploy") } }));
  expect(counted).toEqual(countedManual);
  expect(counted.text.includes("order by")).toBe(false);
  expect(counted.text).toContain("count(*)::text");

  const phrase = await sql(
    db.pages.find({
      search: { for: "deploy rollback", match: "phrase", language: "english" },
      limit: 5,
    }),
  );
  const phraseManual = await sql(
    db.pages.find({
      where: { body: matches("deploy rollback", { match: "phrase", language: "english" }) },
      orderBy: {
        body: relevance("deploy rollback", { match: "phrase", language: "english" }),
        id: "asc",
      },
      limit: 5,
    }),
  );
  expect(phrase).toEqual(phraseManual);
  expect(phrase.text).toContain(`phraseto_tsquery($1::regconfig, $2)`);
  expect(phrase.text).toContain(`ts_rank(t."body", phraseto_tsquery($3::regconfig, $4))`);
  expect(phrase.text.includes("english")).toBe(false);

  const advanced = await sql(
    db.pages.find({ search: { for: "deploy & rollback", match: "advanced" }, limit: 1 }),
  );
  expect(advanced.text).toContain("to_tsquery($1)");
  expect(advanced.text).toContain('ts_rank(t."body", to_tsquery($2))');

  const natural = await sql(db.pages.find({ search: "deploy", limit: 2 }));
  const later = await sql(
    db.pages.find({ search: { for: "deploy", match: "all-words" }, limit: 2 }),
  );
  expect(natural.text).toContain("websearch_to_tsquery");
  expect(later.text).toContain("plainto_tsquery");
  expect(later.text.includes("websearch_to_tsquery")).toBe(false);

  await db.close();
});

test("search names the columns you can search", async () => {
  const db = await connectPglite(stub(), { schema: app });

  expect(await codeOf(() => db.notes.find({ search: "deploy", limit: 1 }))).toBe("OKM1120");
  try {
    await db.notes.find({ search: "deploy", limit: 1 });
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.message).toContain("more than one column");
      expect(error.message).toContain("body");
      expect(error.message).toContain("titleDoc");
      expect(error.message.includes("tsvector")).toBe(false);
    }
  }

  const named = await sql(db.notes.find({ search: { for: "deploy", in: "titleDoc" }, limit: 1 }));
  expect(named.text).toContain(`t."title_doc" @@ websearch_to_tsquery($1)`);

  expect(await codeOf(() => db.tags.find({ search: "deploy", limit: 1 }))).toBe("OKM1120");
  try {
    await db.tags.find({ search: "deploy", limit: 1 });
  } catch (error) {
    if (error instanceof OkmError) expect(error.message).toContain("no column you can search");
  }

  expect(
    await codeOf(() =>
      db.pages.find({ search: { for: "deploy", in: "title" as "body" }, limit: 1 }),
    ),
  ).toBe("OKM1120");
  try {
    await db.pages.find({ search: { for: "deploy", in: "title" as "body" }, limit: 1 });
  } catch (error) {
    if (error instanceof OkmError) {
      expect(error.message).toContain("title");
      expect(error.message).toContain("body");
    }
  }

  const missing = { for: "deploy", in: "missing" } as unknown as {
    readonly for: string;
    readonly in: "body";
  };
  expect(await codeOf(() => db.notes.find({ search: missing, limit: 1 }))).toBe("OKM1120");

  expect(await codeOf(() => db.pages.find({ search: "", limit: 1 }))).toBe("OKM1120");
  expect(await codeOf(() => db.pages.find({ search: undefined as never, limit: 1 }))).toBe(
    "OKM1120",
  );
  expect(await codeOf(() => db.pages.count({ search: undefined as never }))).toBe("OKM1120");
  expect(await codeOf(() => db.pages.find({ search: { for: "" }, limit: 1 }))).toBe("OKM1120");
  expect(
    await codeOf(() =>
      db.pages.find({ search: { for: "deploy", match: "web" as "phrase" }, limit: 1 }),
    ),
  ).toBe("OKM1120");
  expect(await codeOf(() => db.pages.find({ search: { for: "deploy\u0000" }, limit: 1 }))).toBe(
    "OKM1122",
  );

  try {
    await db.pages.one({ search: "deploy" } as never);
    expect(false).toBe(true);
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) expect(error.message).toContain("does not take search");
  }

  const pageOptions = { search: "deploy", limit: 1 };
  try {
    await db.pages.page(pageOptions);
    expect(false).toBe(true);
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.code).toBe("OKM1120");
      expect(error.message).toContain("does not take search in this version");
      expect(error.message).toContain("find");
    }
  }

  await db.close();
});

test("a call with no search key returns every row", async () => {
  const pool = await openPglite();
  try {
    for (const statement of renderCatalog(app.catalog, "public")) await pool.execute(statement);
    const db = await connectPglite(pool, { schema: app });
    await db.connected;
    await db.pages.insert({
      id: "01890c5a-8f0e-7c3a-9b2d-6e4f1a0c0001",
      title: "one",
      body: "deploy",
    });
    await db.pages.insert({
      id: "01890c5a-8f0e-7c3a-9b2d-6e4f1a0c0002",
      title: "two",
      body: "other",
    });
    expect(await db.pages.find({ limit: 10 })).toHaveLength(2);
    expect(await db.pages.count()).toBe(2);
    await db.close();
  } finally {
    await pool.close();
  }
});

test("search of a plain hidden column names hidden({ filterable: true })", async () => {
  const sealed = table("sealed", {
    id: id({ default: "none" }),
    body: tsvector().hidden(),
  });
  const ranked = table("ranked", {
    id: id({ default: "none" }),
    body: tsvector().hidden({ filterable: true }),
  });
  const db = await connectPglite(stub(), {
    schema: schema({ casing: "snake", tables: [sealed, ranked] }),
  });

  try {
    await db.sealed.find({ search: "deploy", limit: 1 });
    expect(false).toBe(true);
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.code).toBe("OKM1120");
      expect(error.message).toContain("hidden({ filterable: true })");
      expect(error.message).toContain("body");
    }
  }

  try {
    await db.sealed.find({
      search: { for: "deploy", in: "body" } as never,
      limit: 1,
    });
    expect(false).toBe(true);
  } catch (error) {
    expect(error).toBeInstanceOf(OkmError);
    if (error instanceof OkmError) {
      expect(error.message).toContain("hidden({ filterable: true })");
    }
  }

  const found = await sql(
    db.ranked.find({
      search: "deploy",
      orderBy: { body: relevance("deploy") },
      limit: 1,
    }),
  );
  expect(found.text).toContain(`t."body" @@ websearch_to_tsquery($1)`);
  expect(found.text).toContain("ts_rank");

  await db.close();
});
