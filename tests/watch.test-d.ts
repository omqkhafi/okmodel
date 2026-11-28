/**
 * `watch` and `until` exist only on a table that sets `watch`.
 * `db.watch` and `tx.notify` exist on every client.
 */

import { expectTypeOf } from "expect-type";

import { schema, table, t } from "../src/dialects/pg/index.js";
import type { Connected, TxClient } from "../src/runtime/types.js";

type Has<T, K extends string> = K extends keyof T ? true : false;

const orders = table("orders", { id: t.integer().primaryKey(), status: t.text() }, { watch: true });
const notes = table("notes", { id: t.integer().primaryKey() });
const products = table(
  "products",
  { id: t.integer().primaryKey() },
  { watch: { feed: { keep: "7d" } } },
);
const app = schema({ casing: "snake", tables: [orders, notes, products] });

type Db = Connected<typeof app>;

expectTypeOf<Has<Db["orders"], "watch">>().toEqualTypeOf<true>();
expectTypeOf<Has<Db["orders"], "until">>().toEqualTypeOf<true>();
expectTypeOf<Has<Db["notes"], "watch">>().toEqualTypeOf<false>();
expectTypeOf<Has<Db["notes"], "until">>().toEqualTypeOf<false>();
expectTypeOf<Has<Db, "watch">>().toEqualTypeOf<true>();

expectTypeOf<Has<Db, "notify">>().toEqualTypeOf<false>();
type Tx = TxClient<typeof app>;
expectTypeOf<Has<Tx, "notify">>().toEqualTypeOf<true>();
expectTypeOf<Has<Tx, "watch">>().toEqualTypeOf<true>();
expectTypeOf<Has<Tx["orders"], "watch">>().toEqualTypeOf<true>();

declare const db: Db;
db.products.watch({ feed: "search" }, (changes) => {
  expectTypeOf(changes[0]?.op).toEqualTypeOf<
    "insert" | "update" | "delete" | "truncate" | undefined
  >();
});
