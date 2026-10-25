/**
 * Filterable hidden columns keep their value type on writes and reads.
 *
 * `count`, `delete`, `exists`, and `update` reject a plain hidden key or an
 * unknown key beside a valid one, and reject a value of the wrong type.
 * `descendants` accepts the same filterable keys in `where` and `orderBy`.
 * `groupBy` and `min` still exclude them.
 * `hidden({ filterable: false })` and a boolean flag still compile. Literal
 * `true` is the only value that sets the filter bit.
 */

import { eq, id, integer, or, relevance, schema, table, text } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

function flagged(flag: boolean) {
  return table("flags", {
    id: id(),
    closed: text().hidden({ filterable: false }),
    dynamic: text().hidden({ filterable: flag }),
    opened: integer().hidden({ filterable: true }),
  });
}

const posts = table("posts", {
  id: id(),
  title: text(),
  score: integer().hidden({ filterable: true }),
  bonus: integer().nullable().hidden({ filterable: true }),
  secret: text().hidden(),
});

const app = schema({ tables: [posts, flagged(true)] });

async function shapes(url: string): Promise<void> {
  const db = connect(url, { schema: app });

  await db.posts.update({ where: { score: 4, title: "a" }, set: { title: "b" } });
  await db.posts.update({ where: { score: eq(4) }, set: { title: "b" } });
  await db.posts.update({ where: { bonus: null }, set: { title: "b" } });
  await db.posts.update({
    where: {
      title: "a",
      // @ts-expect-error score is an integer
      score: "notanumber",
    },
    set: { title: "b" },
  });
  await db.posts.update({
    where: {
      // @ts-expect-error bonus is an integer or null
      bonus: "nope",
    },
    set: { title: "b" },
  });
  await db.posts.update({
    where: {
      title: "a",
      // @ts-expect-error a plain hidden column is not a where key
      secret: "x",
    },
    set: { title: "b" },
  });
  await db.posts.update({
    where: { title: "a" },
    set: { title: "b" },
    // @ts-expect-error unknown option
    nope: true,
  });
  await db.posts.update([{ where: { title: "a" }, set: { title: "b" } }]);
  await db.posts.update([{ where: { score: 1 }, set: { title: "c" } }]);
  // @ts-expect-error a plain hidden column is not a where key
  await db.posts.update([{ where: { title: "a", secret: "x" }, set: { title: "b" } }]);

  await db.posts.count({ where: { score: 1, title: "a" } });
  await db.posts.count({ where: { bonus: null } });
  await db.posts.count({
    where: {
      title: "a",
      // @ts-expect-error score is an integer
      score: "notanumber",
    },
  });
  await db.posts.count({
    where: {
      title: "a",
      // @ts-expect-error a plain hidden column is not a where key
      secret: "x",
    },
  });
  // @ts-expect-error unknown option
  await db.posts.count({ nope: true });

  await db.posts.delete({ where: { score: 1 } });
  await db.posts.delete({
    where: {
      title: "a",
      // @ts-expect-error a plain hidden column is not a where key
      secret: "x",
    },
  });
  await db.posts.delete({
    where: {
      // @ts-expect-error score is an integer
      score: "notanumber",
    },
  });
  await db.posts.delete({
    where: { title: "a" },
    // @ts-expect-error unknown option
    nope: true,
  });

  await db.posts.exists({ where: { score: 1 } });
  await db.posts.exists({ where: { bonus: null } });
  await db.posts.exists({
    where: {
      // @ts-expect-error a plain hidden column is not a where key
      secret: "x",
    },
  });
  await db.posts.exists({
    where: {
      // @ts-expect-error score is an integer
      score: "notanumber",
    },
  });

  await db.flags.count({ where: { opened: 1 } });
  await db.flags.count({
    where: {
      // @ts-expect-error filterable: false does not add a where key
      closed: "x",
    },
  });

  await db.posts.find({ where: { score: 1, title: "a" }, limit: 1 });
  await db.posts.find({
    where: or([{ title: "a" }, { score: 1 }]),
    limit: 1,
  });
  await db.posts.page({ orderBy: { title: "asc" }, limit: 2 });
  // @ts-expect-error page refuses relevance(); the cursor cannot encode a rank
  await db.posts.page({ orderBy: { title: relevance("x") }, limit: 2 });
  await db.posts.count({
    // @ts-expect-error a plain hidden column is not a where key
    where: or([{ title: "a" }, { secret: "x" }]),
  });
  await db.posts.update({
    where: or([{ title: "a" }, { score: 1 }]),
    set: { title: "b" },
  });
  await db.posts.update({
    // @ts-expect-error a plain hidden column is not a where key
    where: or([{ title: "a" }, { secret: "x" }]),
    set: { title: "b" },
  });
  await db.posts.delete({
    // @ts-expect-error a plain hidden column is not a where key
    where: or([{ title: "a" }, { secret: "x" }]),
  });
  await db.posts.ancestors("a", {
    where: {
      title: "a",
      // @ts-expect-error a plain hidden column is not a where key
      secret: "x",
    },
    orderBy: { score: "asc" },
  });
  await db.posts.find({
    orderBy: { score: "desc", id: "asc" },
    limit: 1,
  });
  await db.posts.one({ where: { score: 1 } });
  await db.posts.page({ orderBy: { score: "asc" }, limit: 2 });
  await db.posts.aggregate({
    // @ts-expect-error a filterable hidden column stays off groupBy
    groupBy: ["score"],
    count: true,
    limit: 1,
  });
  await db.posts.aggregate({
    // @ts-expect-error a filterable hidden column stays off min
    min: ["score"],
    limit: 1,
  });
  await db.posts.count({ where: or([{ title: "a" }, { score: 1 }]) });
  await db.posts.exists({ where: or([{ score: 1 }]) });
  await db.posts.exists({
    // @ts-expect-error a plain hidden column is not a where key
    where: or([{ title: "a" }, { secret: "x" }]),
  });
  await db.posts.descendants("a", { where: { score: 1 }, orderBy: { score: "asc" } });
}

void shapes;
