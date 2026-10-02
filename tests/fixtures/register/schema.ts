/**
 * A schema that augments `okmodel` so reference names autocomplete.
 */

import { schema, table, t } from "../../../src/dialects/pg/index.js";

/** Users in the register fixture. */
export const users = table("users", {
  id: t.id(),
  email: t.text(),
});

/** Tasks in the register fixture. */
export const tasks = table("tasks", {
  id: t.id(),
  ownerId: t.uuid().references("users"),
});

/** Schema registered for this project. */
export const appSchema = schema({ tables: [users, tasks] });

declare module "okmodel" {
  interface Register {
    readonly schema: typeof appSchema;
  }
}
