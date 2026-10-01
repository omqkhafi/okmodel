/**
 * Subject for `tsc --declaration`.
 *
 * The emitted `.d.ts` is the hover proxy. The compiler API is not used.
 */

import { t } from "./column.js";
import { table } from "./table.js";

const tasks = table("tasks", {
  id: t.id(),
  title: t.text(),
  notes: t.text().nullable(),
  status: t.text().picklist(["draft", "active"]).default("draft"),
});

/** Inferred row, as declaration emit sees it. */
export type TaskRow = (typeof tasks)["~row"];

/** Inferred insert, as declaration emit sees it. */
export type TaskInsert = (typeof tasks)["~insert"];

/** Inferred update, as declaration emit sees it. */
export type TaskUpdate = (typeof tasks)["~update"];
