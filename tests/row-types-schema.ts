/**
 * Fixture shared by the row-type test and the emitted declaration check.
 */

import { schema, table, t } from "../src/dialects/pg/index.js";

/** Users table for the row-type fixture. */
export const users = table("users", {
  id: t.id(),
  email: t.text(),
  nickname: t.text().nullable(),
});

/** Tasks table for the row-type fixture. */
export const tasks = table("tasks", {
  id: t.id(),
  ownerId: t.uuid().references("users"),
  title: t.varchar(200),
  status: t.varchar(20).picklist(["draft", "active", "done"]).default("draft"),
  notes: t.text().nullable(),
  secret: t.text().hidden(),
  position: t.integer().default(0),
  locked: t.text().guarded(),
});

/** Schema whose inferred rows are compared with the emitted file. */
export const appSchema = schema({ tables: [users, tasks] });
