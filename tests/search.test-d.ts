/**
 * `search`, `matches`, and `relevance` use the same words.
 *
 * `page` refuses `search` when the call runs. A text column still accepts `matches` in the
 * type, and the runtime rejects it.
 */

import { id, matches, relevance, schema, table, text, tsvector } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const pages = table("pages", {
  id: id(),
  title: text(),
  body: tsvector(),
});

const notes = table("notes", {
  id: id(),
  body: tsvector(),
  titleDoc: tsvector(),
});

const app = schema({ casing: "snake", tables: [pages, notes] });

async function shapes(url: string): Promise<void> {
  const db = connect(url, { schema: app });
  const rows = await db.pages.find({
    search: "deploy rollback",
    where: { title: "ship" },
    select: ["id", "title"],
    limit: 5,
  });
  rows satisfies readonly { readonly id: string; readonly title: string }[];

  await db.pages.find({
    search: { for: "deploy", in: "body", match: "phrase", language: "english" },
    orderBy: { title: "asc" },
    limit: 5,
  });
  await db.notes.find({ search: { for: "deploy", in: "titleDoc" }, limit: 1 });
  await db.pages.count({ search: "deploy", where: { title: "ship" } });
  await db.pages.find({
    where: { body: matches("deploy", { match: "all-words", language: "english" }) },
    orderBy: {
      body: relevance("deploy", { match: "all-words", language: "english" }),
      id: "asc",
    },
    limit: 5,
  });
  await db.pages.find({
    where: {
      // @ts-expect-error mode and config were renamed to match and language
      body: matches("deploy", { mode: "plain", config: "english" }),
    },
    limit: 1,
  });
  await db.pages.find({
    search: {
      for: "deploy",
      // @ts-expect-error in names a column on the table
      in: "missing",
    },
    limit: 1,
  });
  await db.pages.page({ limit: 1 });
  // @ts-expect-error page refuses relevance(); the cursor cannot encode a rank
  await db.pages.page({ orderBy: { body: relevance("deploy") }, limit: 1 });
  await db.pages.one({
    // @ts-expect-error one does not take search
    search: "deploy",
  });
}

void shapes;
