/**
 * Result types of the `aggregate` options added in F8.
 */

import { expectTypeOf } from "expect-type";

import { integer, schema, table, text, uuid } from "../src/dialects/pg/index.js";
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
