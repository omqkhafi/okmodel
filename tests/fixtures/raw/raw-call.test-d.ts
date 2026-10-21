/**
 * `raw(db, sql, params)` takes a literal the generated declaration lists, types
 * its parameters, and returns its rows. The class form keeps its types.
 */

import { expectTypeOf } from "expect-type";

import { fragment, ident, raw, registerRawLock, trusted } from "okmodel/pg";

declare const db: object;

const area = raw(db, "select area from tasks", []);
expectTypeOf(area).toEqualTypeOf<Promise<readonly { readonly area: string }[]>>();

const labels = raw(db, "select labels from tasks where mood = any($1)", [["open", "closed"]]);
expectTypeOf(labels).toEqualTypeOf<
  Promise<readonly { readonly labels: ("open" | "closed")[] }[]>
>();

const payload = raw(db, "select payload, meta from tasks", []);
expectTypeOf(payload).resolves.items.toHaveProperty("payload");

// @ts-expect-error The label is not in the enum.
raw(db, "select labels from tasks where mood = any($1)", [["nope"]]);

// @ts-expect-error The statement takes one parameter.
raw(db, "select labels from tasks where mood = any($1)", []);

// @ts-expect-error The statement takes none.
raw(db, "select area from tasks", ["extra"]);

// @ts-expect-error No entry in RawStatements: run okm raw sync.
raw(db, "select 1", []);

declare const dynamic: string;
// @ts-expect-error Dynamic SQL stays on the class form.
raw(db, dynamic, []);

class Row {
  id = "";
}
declare const handle: object;
const classed = raw(handle, Row, "read", fragment`select ${ident("id")} from tasks`);
expectTypeOf(classed).toEqualTypeOf<Promise<Row[]>>();

expectTypeOf(trusted(db, "reason")).toEqualTypeOf<object>();
expectTypeOf(registerRawLock).parameter(0).toBeUnknown();
