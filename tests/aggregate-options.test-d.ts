/**
 * Result types of the `aggregate` options added in F8.
 */

import { expectTypeOf } from "expect-type";

import { gt, gte, integer, not, or, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import type { Connected } from "../src/runtime/types.js";

const sales = table("sales", {
  id: uuid().primaryKey(),
  region: text(),
  customer: text().nullable(),
  amount: integer().nullable(),
});

const app = schema({ tables: [sales] });
declare const db: Connected<typeof app>;

const distinct = db.sales.aggregate({
  groupBy: ["region"],
  countDistinct: ["customer", "region"],
  limit: 1,
});
type Distinct = Awaited<typeof distinct>[number];
expectTypeOf<keyof Distinct>().toEqualTypeOf<"region" | "countDistinct">();
expectTypeOf<Distinct["countDistinct"]>().toEqualTypeOf<{
  readonly customer: number;
  readonly region: number;
}>();

// @ts-expect-error countDistinct takes field names of the table
void db.sales.aggregate({ countDistinct: ["nope"], limit: 1 });

const named = db.sales.aggregate({
  groupBy: ["region"],
  count: true,
  select: {
    rows: { count: true },
    buyers: { countDistinct: "customer" },
    total: { sum: "amount" },
    mean: { avg: "amount" },
    first: { min: "customer" },
    last: { max: "region" },
  },
  limit: 1,
});
type Named = Awaited<typeof named>[number];
expectTypeOf<Named["region"]>().toEqualTypeOf<string>();
expectTypeOf<Named["count"]>().toEqualTypeOf<number>();
expectTypeOf<Named["rows"]>().toEqualTypeOf<number>();
expectTypeOf<Named["buyers"]>().toEqualTypeOf<number>();
expectTypeOf<Named["total"]>().toEqualTypeOf<number | null>();
expectTypeOf<Named["mean"]>().toEqualTypeOf<number | null>();
expectTypeOf<Named["first"]>().toEqualTypeOf<string | null>();
expectTypeOf<Named["last"]>().toEqualTypeOf<string | null>();

// @ts-expect-error a select entry names a field of the table
void db.sales.aggregate({ select: { x: { max: "nope" } }, limit: 1 });
// @ts-expect-error sum takes a numeric field
void db.sales.aggregate({ select: { x: { sum: "nope" } }, limit: 1 });
// @ts-expect-error a select entry is one function, not a list
void db.sales.aggregate({ select: { x: { sum: ["amount"] } }, limit: 1 });

// having over count, and over the names of select
void db.sales.aggregate({ groupBy: ["region"], having: { count: gte(2) }, limit: 1 });
void db.sales.aggregate({
  groupBy: ["region"],
  select: { total: { sum: "amount" }, first: { min: "customer" } },
  having: { total: gt(10), count: 3, first: not(null) },
  limit: 1,
});
void db.sales.aggregate({
  groupBy: ["region"],
  select: { total: { sum: "amount" } },
  having: or([{ total: null }, { count: gte(2) }]),
  limit: 1,
});
void db.sales.aggregate({ groupBy: ["region"], having: { count: gte(2) } }).all("report");

// @ts-expect-error having names count and the select names only
void db.sales.aggregate({ groupBy: ["region"], having: { nope: gte(2) }, limit: 1 });
void db.sales.aggregate({
  groupBy: ["region"],
  select: { total: { sum: "amount" } },
  // @ts-expect-error amount is a field, not an aggregate name
  having: { amount: gt(1) },
  limit: 1,
});
void db.sales.aggregate({
  groupBy: ["region"],
  select: { total: { sum: "amount" } },
  // @ts-expect-error a sum compares with a number
  having: { total: "ten" },
  limit: 1,
});

const ordered = db.sales.aggregate({
  groupBy: ["region"],
  select: { revenue: { sum: "amount" } },
  orderBy: {
    revenue: { dir: "desc", nulls: "last" },
    count: "asc",
    region: { dir: "asc", nulls: "first" },
  },
  limit: 1,
});
expectTypeOf<keyof Awaited<typeof ordered>[number]>().toEqualTypeOf<"region" | "revenue">();
