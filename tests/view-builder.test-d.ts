/**
 * `view(name, { tables }, (q) => q.notes.find(...))` types `db.views` from the columns.
 */

import { expectTypeOf } from "expect-type";

import { schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { view } from "../src/dialects/pg/view/index.js";
import type { Connected } from "../src/runtime/types.js";

const notes = table("notes", { id: text(), title: text(), ownerId: uuid() });
const hidden = table("other", { id: text() });
const app = schema({
  tables: [notes, hidden],
  views: [
    view("active_notes", { tables: [notes] }, (q) => q.notes.find({ select: ["id", "title"] })),
  ],
});
declare const db: Connected<typeof app>;

const rows = db.views.activeNotes.find({ limit: 1 });

expectTypeOf<keyof Awaited<typeof rows>[number]>().toEqualTypeOf<"id" | "title">();
expectTypeOf<Awaited<typeof rows>[number]["title"]>().toEqualTypeOf<string>();

// @ts-expect-error a table that was not declared
void view("closed", { tables: [notes] }, (q) => q.other.find());
