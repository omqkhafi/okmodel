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
const app = schema({ casing: "snake", tables: [orders, notes] });

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
