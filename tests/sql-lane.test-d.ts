/**
 * The result of `raw` is the caller's class.
 */

import { expectTypeOf } from "expect-type";

import { explain, fragment, ident, raw, schema, table, text } from "../src/dialects/pg/index.js";
import type { ExplainResult } from "../src/dialects/pg/ops/lane.js";
import type { Connected } from "../src/runtime/types.js";

const notes = table("notes", { id: text().primaryKey(), title: text() });
const app = schema({ tables: [notes] });
declare const db: Connected<typeof app>;

class NoteRow {
  id = "";
  title = "";
}

const rows = raw(
  db.notes,
  NoteRow,
  "read",
  fragment`select ${ident("id")}, ${ident("title")} from notes`,
);
expectTypeOf<Awaited<typeof rows>>().toEqualTypeOf<NoteRow[]>();

const plan = explain(db.notes, db.notes.one());
expectTypeOf<Awaited<typeof plan>>().toEqualTypeOf<ExplainResult>();
