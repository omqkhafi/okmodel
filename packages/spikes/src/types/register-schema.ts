/**
 * Single `Register.schema` augmentation.
 *
 * Table files do not import each other. This file is the one that sees both.
 */

import { citextExtension } from "./extensions/citext.js";
import { tasks } from "./register-tasks.js";
import { users } from "./register-users.js";
import { schema } from "./schema.js";

/** Sample schema. References stay inside the table list. */
export const appSchema = schema({
  extensions: [citextExtension()],
  tables: [users, tasks],
});

declare module "@okmodel/spikes/types" {
  interface Register {
    readonly schema: typeof appSchema;
  }
}
