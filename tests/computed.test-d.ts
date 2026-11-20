/**
 * Types of `computed`: the value follows the verb, the callback sees `many`
 * relations only, and `where` and `orderBy` take the computed names.
 */

import { expectTypeOf } from "expect-type";

import { fragment, gte, ident, inList } from "../src/dialects/pg/index.js";
import type { Connected } from "../src/runtime/types.js";
import { app } from "./relations-schema.js";

type Scoped = ReturnType<Connected<typeof app>["for"]>;
declare const a: Scoped;
const calc = { linkCount: () => fragment`1` };

const rows = a.tasks.find({
  limit: 5,
  computed: {
    linkCount: (t) => t.links.count(),
    open: (t) => t.links.exists(),
    named: (t) => t.labels.count({ where: { name: "x" }, distinct: "name" }),
    shared: (t) => t.links.max("taskId"),
    ratio: (t) => fragment`${t.links.count()} / nullif(${ident("score")}, 0)`,
  },
});
type Row = Awaited<typeof rows>[number];
expectTypeOf<Row["linkCount"]>().toEqualTypeOf<number>();
expectTypeOf<Row["open"]>().toEqualTypeOf<boolean>();
expectTypeOf<Row["named"]>().toEqualTypeOf<number>();
expectTypeOf<Row["shared"]>().toEqualTypeOf<string | null>();
expectTypeOf<Row["ratio"]>().toEqualTypeOf<number | null>();
expectTypeOf<Row["title"]>().toEqualTypeOf<string>();

const byLabel = a.labels.find({
  limit: 5,
  computed: {
    score: (l) => l.tasks.sum("score"),
    mean: (l) => l.tasks.avg("score", { where: { team: "a" } }),
    first: (l) => l.tasks.min("title"),
    last: (l) => l.tasks.max("due"),
    weight: (l) => l.tasks.sum(fragment`${ident("score")} * 2`),
  },
});
type LabelRow = Awaited<typeof byLabel>[number];
expectTypeOf<LabelRow["score"]>().toEqualTypeOf<number | null>();
expectTypeOf<LabelRow["mean"]>().toEqualTypeOf<number | null>();
expectTypeOf<LabelRow["first"]>().toEqualTypeOf<string | null>();
expectTypeOf<LabelRow["weight"]>().toEqualTypeOf<number | null>();
void a.labels.find({
  limit: 5,
  // @ts-expect-error sum takes a numeric field
  computed: { n: (l) => l.tasks.sum("nope") },
});

const narrow = a.tasks.find({
  select: ["id"],
  limit: 5,
  computed: { linkCount: (t) => t.links.count() },
});
expectTypeOf<keyof Awaited<typeof narrow>[number]>().toEqualTypeOf<"id" | "linkCount">();

// where and orderBy take the computed names, with the filters their type takes.
void a.tasks.find({
  limit: 5,
  where: { linkCount: gte(2), title: "x" },
  orderBy: { linkCount: "desc", title: "asc" },
  computed: { linkCount: (t) => t.links.count() },
});
void a.tasks.find({
  limit: 5,
  where: { open: true },
  computed: { open: (t) => t.links.exists() },
});
void a.tasks.find({
  limit: 5,
  where: { linkCount: inList([1, 2]) },
  computed: { linkCount: (t) => t.links.count() },
});
// @ts-expect-error a count filters with a number
void a.tasks.find({ limit: 5, where: { linkCount: gte("2") }, computed: calc });
// @ts-expect-error a name that is neither a field nor computed
void a.tasks.find({ limit: 5, where: { nope: 1 }, computed: calc });
// @ts-expect-error a name that is neither a field nor computed
void a.tasks.find({ limit: 5, orderBy: { nope: "asc" }, computed: calc });

// The callback sees `many` relations, and each verb takes its fields.
void a.tasks.find({
  limit: 5,
  // @ts-expect-error a field is not a relation
  computed: { n: (t) => t.title.count() },
});
void a.tasks.find({
  limit: 5,
  // @ts-expect-error a verb outside the list
  computed: { n: (t) => t.links.median("id") },
});
void a.tasks.find({
  limit: 5,
  // @ts-expect-error a field of the related table
  computed: { n: (t) => t.links.max("nope") },
});
void a.tasks.find({
  limit: 5,
  // @ts-expect-error the filter names a field of the related table
  computed: { n: (t) => t.links.count({ where: { title: "x" } }) },
});
void a.tasks.find({
  limit: 5,
  // @ts-expect-error the callback must return an aggregate or a fragment
  computed: { n: () => 1 },
});

// one, page, count, and exists take computed too. page cannot order by it.
const one = a.tasks.one({ computed: { linkCount: (t) => t.links.count() } });
expectTypeOf<NonNullable<Awaited<typeof one>>["linkCount"]>().toEqualTypeOf<number>();
const page = a.tasks.page({
  limit: 5,
  orderBy: { title: "asc" },
  where: { linkCount: gte(1) },
  computed: { linkCount: (t) => t.links.count() },
});
expectTypeOf<Awaited<typeof page>["items"][number]["linkCount"]>().toEqualTypeOf<number>();
// @ts-expect-error a page cursor holds no computed value
void a.tasks.page({
  limit: 5,
  orderBy: { linkCount: "asc" },
  computed: { linkCount: () => fragment`1` },
});
const counted = a.tasks.count({
  where: { linkCount: gte(1) },
  computed: { linkCount: (t) => t.links.count() },
});
expectTypeOf<Awaited<typeof counted>>().toEqualTypeOf<number>();
const found = a.tasks.exists({
  where: { linkCount: gte(1) },
  computed: { linkCount: (t) => t.links.count() },
});
expectTypeOf<Awaited<typeof found>>().toEqualTypeOf<boolean>();
