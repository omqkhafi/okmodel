/**
 * `hidden({ filterable: true })` is a `where` and `orderBy` key.
 *
 * A plain `.hidden()` column stays off that set, including `relevance()`.
 */

import { id, matches, relevance, schema, table, tsvector } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const pages = table("pages", {
  id: id(),
  body: tsvector().hidden({ filterable: true }).nullable(),
  secret: tsvector().hidden(),
});

const app = schema({ tables: [pages] });

async function shapes(url: string): Promise<void> {
  const db = connect(url, { schema: app });
  await db.pages.find({
    where: { body: matches("deploy") },
    orderBy: { body: relevance("deploy"), id: "asc" },
    search: { for: "deploy", in: "body" },
    limit: 1,
  });
  await db.pages.find({
    orderBy: {
      // @ts-expect-error a plain hidden column is not an orderBy key
      secret: relevance("deploy"),
    },
    limit: 1,
  });
  await db.pages.find({
    select: [
      "id",
      // @ts-expect-error a filterable hidden column stays off the row
      "body",
    ],
    limit: 1,
  });
  await db.pages.find({
    search: {
      for: "deploy",
      // @ts-expect-error a plain hidden column is not a search column
      in: "secret",
    },
    limit: 1,
  });
  await db.pages.one({
    where: { body: matches("deploy") },
    orderBy: { body: relevance("deploy") },
  });
  await db.pages.update({ where: { body: matches("deploy") }, set: { body: null } });
  await db.pages.delete({ where: { body: matches("deploy") } });
  // @ts-expect-error wait is a read option
  await db.pages.update({ where: { id: "a" }, set: { body: null }, wait: "skip" });
  // @ts-expect-error a plain hidden column is not a where key
  await db.pages.update({ where: { secret: matches("deploy") }, set: { body: null } });
}

void shapes;
