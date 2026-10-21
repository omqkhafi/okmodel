/**
 * `distinct` and `distinctOn` on `find`: the row follows `select`, and the
 * options take the table's own field names.
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

const regions = db.sales.find({ distinct: true, select: ["region", "customer"], limit: 10 });
expectTypeOf<Awaited<typeof regions>>().toEqualTypeOf<
  readonly { readonly region: string; readonly customer: string | null }[]
>();

const latest = db.sales.find({
  distinctOn: ["customer"],
  orderBy: { customer: "asc", amount: "desc" },
  select: ["customer", "amount"],
  limit: 10,
});
expectTypeOf<Awaited<typeof latest>[number]>().toEqualTypeOf<{
  readonly customer: string | null;
  readonly amount: number | null;
}>();

// @ts-expect-error distinct is true, not false
void db.sales.find({ distinct: false, select: ["region"], limit: 1 });
// @ts-expect-error distinctOn takes field names of the table
void db.sales.find({ distinctOn: ["nope"], orderBy: { region: "asc" }, limit: 1 });
