/**
 * Result types of manyThrough, page, and aggregate.
 */

import { expectTypeOf } from "expect-type";

import { has } from "../src/dialects/pg/index.js";
import type { Connected, Page } from "../src/runtime/types.js";
import { app } from "./relations-schema.js";

type Scoped = ReturnType<Connected<typeof app>["for"]>;
declare const a: Scoped;

// manyThrough reads as a to-many relation: include needs a limit, filters take has/none/every.
const withLabels = a.tasks.find({ include: { labels: { limit: 3 } }, limit: 1 });
expectTypeOf<
  Awaited<typeof withLabels>[number]["labels"][number]["name"]
>().toEqualTypeOf<string>();
void a.tasks.find({ where: { labels: has({ name: "x" }) }, limit: 1 });
void a.labels.find({ where: { tasks: has({ title: "x" }) }, limit: 1 });
// @ts-expect-error a to-many include needs a limit
void a.tasks.find({ include: { labels: {} }, limit: 1 });
// @ts-expect-error the filter names a field of the related table
void a.tasks.find({ where: { labels: has({ title: "x" }) }, limit: 1 });

// page: `{ items, next }`, the rows follow select, limit is required.
const page = a.tasks.page({ orderBy: { title: "asc" }, limit: 10 });
expectTypeOf<Awaited<typeof page>["next"]>().toEqualTypeOf<string | null>();
expectTypeOf<Awaited<typeof page>["items"][number]["title"]>().toEqualTypeOf<string>();
const narrow = a.tasks.page({ select: ["id", "title"], limit: 10 });
expectTypeOf<keyof Awaited<typeof narrow>["items"][number]>().toEqualTypeOf<"id" | "title">();
const included = a.tasks.page({ include: { labels: { limit: 2 } }, limit: 10 });
expectTypeOf<
  Awaited<typeof included>["items"][number]["labels"][number]["id"]
>().toEqualTypeOf<string>();
expectTypeOf<Awaited<typeof page>>().toExtend<Page<{ readonly id: string }>>();
// @ts-expect-error page needs a limit
void a.tasks.page({ orderBy: { title: "asc" } });
// @ts-expect-error after is a cursor string
void a.tasks.page({ limit: 1, after: 3 });

// aggregate: the shape follows the options.
const grouped = a.tasks.aggregate({
  groupBy: ["team"],
  count: true,
  sum: ["score"],
  avg: ["score"],
  min: ["title"],
  max: ["score"],
  limit: 5,
});
type Group = Awaited<typeof grouped>[number];
expectTypeOf<Group["team"]>().toEqualTypeOf<string | null>();
expectTypeOf<Group["count"]>().toEqualTypeOf<number>();
expectTypeOf<Group["sum"]["score"]>().toEqualTypeOf<number | null>();
expectTypeOf<Group["avg"]["score"]>().toEqualTypeOf<number | null>();
expectTypeOf<Group["min"]["title"]>().toEqualTypeOf<string | null>();
expectTypeOf<Group["max"]["score"]>().toEqualTypeOf<number | null>();
const total = a.tasks.aggregate({ count: true });
expectTypeOf<keyof Awaited<typeof total>[number]>().toEqualTypeOf<"count">();
// sum and avg keep the column's value type: a numeric column is a string by default.
const money = a.ledger.aggregate({ sum: ["amount", "rate"], avg: ["amount"], max: ["amount"] });
type Money = Awaited<typeof money>[number];
expectTypeOf<Money["sum"]["amount"]>().toEqualTypeOf<string | null>();
expectTypeOf<Money["sum"]["rate"]>().toEqualTypeOf<number | null>();
expectTypeOf<Money["avg"]["amount"]>().toEqualTypeOf<string | null>();
expectTypeOf<Money["max"]["amount"]>().toEqualTypeOf<string | null>();
// A grouped call needs a limit, or .all(reason).
const open = a.tasks.aggregate({ groupBy: ["team"], count: true });
expectTypeOf<typeof open.all>().toBeFunction();
// @ts-expect-error sum takes number or string fields, not a timestamp
void a.tasks.aggregate({ sum: ["due"] });
// @ts-expect-error an unknown field
void a.tasks.aggregate({ groupBy: ["nope"], limit: 1 });
