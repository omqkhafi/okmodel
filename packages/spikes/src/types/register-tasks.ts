/**
 * Second table file. The foreign key is a name, so this file does not import users.
 */

import { t } from "./column.js";
import { table } from "./table.js";

/** Tasks table for the Register sample. Covers the generics suite. */
export const tasks = table(
  "tasks",
  {
    id: t.id(),
    ownerId: t.uuid().references("users"),
    title: t.varchar(200),
    status: t.text().picklist(["draft", "active", "done"]).default("draft"),
    notes: t.text().nullable(),
    meta: t.json<{ readonly ok: boolean }>(),
    tags: t.text().array(),
    rank: t.integer().generated(),
    secret: t.text().hidden(),
    role: t.text().guarded(),
    kind: t.enum("task_kind", ["bug", "feature"]),
  },
  { traits: ["archivable"] },
);

declare module "@okmodel/spikes/types" {
  interface RegisteredTables {
    readonly tasks: typeof tasks;
  }
}
