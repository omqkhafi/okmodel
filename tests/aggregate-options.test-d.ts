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
