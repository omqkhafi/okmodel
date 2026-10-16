/**
 * `view(name, (q) => q.from(...))` types `db.views` from the column list.
 */

import { expectTypeOf } from "expect-type";

import { schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { view } from "../src/dialects/pg/view/index.js";
import type { Connected } from "../src/runtime/types.js";

const notes = table("notes", { id: text(), title: text(), ownerId: uuid() });
const app = schema({
  tables: [notes],
  views: [view("active_notes", (q) => q.from(notes, ["id", "title"]))],
});
declare const db: Connected<typeof app>;

const rows = db.views.activeNotes.find({ limit: 1 });

expectTypeOf<keyof Awaited<typeof rows>[number]>().toEqualTypeOf<"id" | "title">();
expectTypeOf<Awaited<typeof rows>[number]["title"]>().toEqualTypeOf<string | null>();
