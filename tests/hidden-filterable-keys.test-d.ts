/**
 * Filterable hidden columns keep their value type on writes and reads.
 *
 * `count`, `delete`, `exists`, and `update` reject a plain hidden key or an
 * unknown key beside a valid one, and reject a value of the wrong type.
 * `find`, `one`, and `page` reject the same keys in `where`, `or()`, `orderBy`,
 * and include options. `page` also rejects an unknown top-level option.
 * `exists`, include, `descendants`, and `aggregate` accept a filterable hidden
 * column in `where` and `orderBy` where the call does.
 * `groupBy` and `min` still exclude them.
 * `hidden({ filterable })` accepts only literal `true`. `false` and a boolean
 * variable are type errors. Literal `true` is the only value that sets the filter bit.
 * `aggregate({ where })` accepts a comparison on that column.
 */

import {
  eq,
  gt,
  id,
  integer,
  many,
  or,
  relevance,
  schema,
  table,
  text,
} from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/postgresjs.js";

const flag: boolean = true;

const flags = table("flags", {
  id: id(),
  opened: integer().hidden({ filterable: true }),
});

const replies = table("replies", {
  id: id(),
  postId: integer(),
  title: text(),
  score: integer().hidden({ filterable: true }),
  secret: text().hidden(),
});

const posts = table(
  "posts",
  {
    id: id(),
    title: text(),
    score: integer().hidden({ filterable: true }),
    bonus: integer().nullable().hidden({ filterable: true }),
    secret: text().hidden(),
  },
  { relations: { replies: many("replies") } },
);

const app = schema({ tables: [posts, replies, flags] });

async function shapes(url: string): Promise<void> {
  const db = connect(url, { schema: app });

  await db.posts.update({ where: { score: 4, title: "a" }, set: { title: "b" } });
  await db.posts.update({ where: { score: eq(4) }, set: { title: "b" } });
  await db.posts.update({ where: { bonus: null }, set: { title: "b" } });
  // @ts-expect-error score is an integer
  await db.posts.update({ where: { title: "a", score: "notanumber" }, set: { title: "b" } });
  // @ts-expect-error bonus is an integer or null
  await db.posts.update({ where: { bonus: "nope" }, set: { title: "b" } });
  // @ts-expect-error a plain hidden column is not a where key
  await db.posts.update({ where: { title: "a", secret: "x" }, set: { title: "b" } });
  // @ts-expect-error unknown option
  await db.posts.update({ where: { title: "a" }, set: { title: "b" }, nope: true });
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
  // @ts-expect-error hidden({ filterable }) accepts only literal true
  text().hidden({ filterable: false });
  // @ts-expect-error a boolean variable is not literal true
  text().hidden({ filterable: flag });

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
  await db.posts.aggregate({ where: { score: 1, title: "a" }, count: true });
  await db.posts.aggregate({ where: { score: gt(1) }, count: true });
  await db.posts.aggregate({ where: { score: eq(1), title: "a" }, count: true });
  await db.posts.aggregate({
    where: { score: gt(1) },
    groupBy: ["title"],
    count: true,
    limit: 1,
  });
  await db.posts.find({
    where: { score: 1 },
    orderBy: { score: "asc" },
    include: { replies: { where: { score: 1 }, orderBy: { score: "desc" }, limit: 1 } },
    limit: 1,
  });
  await db.posts.one({
    where: { score: 1 },
    orderBy: { score: "asc" },
    include: { replies: { where: { score: 1 }, orderBy: { score: "asc" }, limit: 1 } },
  });
  await db.posts.page({
    where: { score: 1 },
    orderBy: { score: "asc" },
    include: { replies: { where: { score: 1 }, orderBy: { score: "asc" }, limit: 1 } },
    limit: 2,
  });

  await db.posts.find({
    where: {
      title: "a",
      // @ts-expect-error a plain hidden column is not a where key
      secret: "x",
    },
    limit: 1,
  });
  await db.posts.one({
    where: {
      title: "a",
      // @ts-expect-error a plain hidden column is not a where key
      secret: "x",
    },
  });
  // @ts-expect-error a plain hidden column is not a where key
  await db.posts.page({
    where: { title: "a", secret: "x" },
    orderBy: { title: "asc" },
    limit: 2,
  });

  await db.posts.find({
    where: {
      title: "a",
      // @ts-expect-error nope is not a where key
      nope: "x",
    },
    limit: 1,
  });
  await db.posts.one({
    where: {
      title: "a",
      // @ts-expect-error nope is not a where key
      nope: "x",
    },
  });
  // @ts-expect-error nope is not a where key
  await db.posts.page({
    where: { title: "a", nope: "x" },
    orderBy: { title: "asc" },
    limit: 2,
  });

  await db.posts.find({
    where: {
      title: "a",
      // @ts-expect-error score is an integer
      score: "notanumber",
    },
    limit: 1,
  });
  await db.posts.one({
    where: {
      // @ts-expect-error score is an integer
      score: "notanumber",
    },
  });
  // @ts-expect-error score is an integer
  await db.posts.page({
    where: { score: "notanumber" },
    orderBy: { title: "asc" },
    limit: 2,
  });

  await db.posts.find({
    // @ts-expect-error a plain hidden column is not a where key
    where: or([{ title: "a" }, { secret: "x" }]),
    limit: 1,
  });
  await db.posts.one({
    // @ts-expect-error a plain hidden column is not a where key
    where: or([{ title: "a" }, { secret: "x" }]),
  });
  // @ts-expect-error a plain hidden column is not a where key
  await db.posts.page({
    where: or([{ title: "a" }, { secret: "x" }]),
    orderBy: { title: "asc" },
    limit: 2,
  });

  await db.posts.find({
    // @ts-expect-error a plain hidden column is not an orderBy key
    orderBy: { title: "asc", secret: "asc" },
    limit: 1,
  });
  await db.posts.one({
    // @ts-expect-error a plain hidden column is not an orderBy key
    orderBy: { secret: "desc" },
  });
  // @ts-expect-error a plain hidden column is not an orderBy key
  await db.posts.page({
    orderBy: { title: "asc", secret: "asc" },
    limit: 2,
  });

  // @ts-expect-error unknown option
  await db.posts.page({
    orderBy: { title: "asc" },
    limit: 2,
    nope: true,
  });

  await db.posts.find({
    include: {
      replies: {
        where: {
          title: "a",
          // @ts-expect-error a plain hidden column is not a where key
          secret: "x",
        },
        limit: 1,
      },
    },
    limit: 1,
  });
  await db.posts.one({
    include: {
      replies: {
        where: {
          title: "a",
          // @ts-expect-error nope is not a where key
          nope: "x",
        },
        limit: 1,
      },
    },
  });
  // @ts-expect-error score is an integer
  await db.posts.page({
    include: {
      replies: {
        where: { score: "notanumber" },
        limit: 1,
      },
    },
    orderBy: { title: "asc" },
    limit: 2,
  });
  await db.posts.find({
    include: {
      replies: {
        // @ts-expect-error a plain hidden column is not a where key
        where: or([{ title: "a" }, { secret: "x" }]),
        limit: 1,
      },
    },
    limit: 1,
  });
  await db.posts.one({
    include: {
      replies: {
        // @ts-expect-error a plain hidden column is not an orderBy key
        orderBy: { secret: "asc" },
        limit: 1,
      },
    },
  });
  // @ts-expect-error unknown option
  await db.posts.page({
    include: {
      replies: {
        limit: 1,
        nope: true,
      },
    },
    orderBy: { title: "asc" },
    limit: 2,
  });
}

void shapes;
