/**
 * One table file. It registers `users` and does not import `tasks`.
 */

import { t } from "./column.js";
import { table } from "./table.js";

/** Users table for the Register sample. */
export const users = table("users", {
  id: t.id(),
  email: t.text(),
  nickname: t.text().nullable(),
});

declare module "@okmodel/spikes/types" {
  interface RegisteredTables {
    readonly users: typeof users;
  }
}
