/**
 * Operators fit their column types (spec §10.1).
 *
 * Text and tsvector are both `string`, so `matches` is accepted on either and
 * the runtime rejects a text column. `unknown` keeps every family.
 */

import { expectTypeOf } from "expect-type";

import {
  arr,
  containedBy,
  contains,
  eq,
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
import { connect } from "../src/runtime/pg/postgresjs.js";

const docs = table("docs", {
  id: id(),
  title: text(),
  tags: text().array(),
  meta: jsonb<{ readonly published: boolean }>(),
  loose: jsonb(),
  doc: t.json<{ readonly title: string }>(),
  span: int4range(),
  body: tsvector(),
  count: integer(),
});

const app = schema({ casing: "snake", tables: [docs] });

const span = {
  empty: false as const,
  lower: 1,
  upper: 10,
  lowerInclusive: true,
  upperInclusive: false,
};

async function shapes(url: string): Promise<void> {
  const db = connect(url, { schema: app });
  const rows = await db.docs.find({
    where: {
      title: contains("hip"),
      tags: overlaps(["news"]),
      meta: path(["published"], eq(true)),
      doc: path(["title"], eq("a")),
      span: containedBy(span),
      body: matches("ship", { mode: "plain", config: "english" }),
      loose: hasAnyKey(["published"]),
    },
    limit: 1,
  });
  expectTypeOf(rows).toMatchTypeOf<readonly { readonly title: string }[]>();

  await db.docs.find({
    where: { meta: contains({ published: true }), tags: contains(["news"]) },
    limit: 1,
  });
  await db.docs.find({ where: { meta: hasKey("published") }, limit: 1 });
  await db.docs.find({ where: { body: matches("ship") }, limit: 1 });
  // tsvector is `string`, so a text column accepts matches and the runtime rejects it.
  await db.docs.find({ where: { title: matches("ship") }, limit: 1 });

  await db.docs.update({
    where: { id: "00000000-0000-4000-8000-000000000001" },
    set: { meta: json.set(["published"], true), tags: arr.append("news") },
  });
  await db.docs.update({
    where: { id: "00000000-0000-4000-8000-000000000001" },
    set: { tags: arr.remove("news"), doc: json.set(["title"], "b") },
  });

  await db.docs.find({
    where: {
      // @ts-expect-error an integer column does not take contains
      count: contains(1),
    },
    limit: 1,
  });
  await db.docs.find({
    where: {
      // @ts-expect-error an integer column does not take hasKey
      count: hasKey("n"),
    },
    limit: 1,
  });
  await db.docs.find({
    where: {
      // @ts-expect-error an array column does not take hasKey
      tags: hasKey("news"),
    },
    limit: 1,
  });
  await db.docs.find({
    where: {
      // @ts-expect-error jsonb does not take overlaps
      meta: overlaps({ published: true }),
    },
    limit: 1,
  });
  await db.docs.find({
    where: {
      // @ts-expect-error text does not take a json path
      title: path(["published"], eq(true)),
    },
    limit: 1,
  });
  await db.docs.update({
    where: { id: "00000000-0000-4000-8000-000000000001" },
    set: {
      // @ts-expect-error text does not take json.set
      title: json.set(["published"], true),
    },
  });
  await db.docs.update({
    where: { id: "00000000-0000-4000-8000-000000000001" },
    set: {
      // @ts-expect-error jsonb does not take arr.append
      meta: arr.append("news"),
    },
  });
  await db.docs.update({
    where: { id: "00000000-0000-4000-8000-000000000001" },
    set: {
      // @ts-expect-error a text array element is a string
      tags: arr.append(1),
    },
  });
}

void shapes;
