/**
 * Validation rules (`okmodel/validate`).
 *
 * Importing this module registers the client hook. An application that does
 * not import it does not load the hook or the engine. It also merges the
 * typed surface (`insert.validate`, `check`, `pick`, `omit`, the Standard
 * Schema members, and `update.validate`) into the table type, so a program
 * that does not import it does not see or pay for those types.
 */

import type { QuerySchema } from "../../dialects/pg/model.js";
import type { ValidateInsert, ValidateUpdate } from "./surface.js";
import { armValidation } from "./bind.js";

armValidation();

declare module "../types.js" {
  // The parameters repeat the declaration they merge into.
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
  interface TableExtras<S extends QuerySchema, K extends keyof S["~byName"] & string> {
    /** `insert` plus the validation members when this table validates. */
    readonly insert: ValidateInsert<S, K>;
    /** `update` plus `validate` when this table validates. */
    readonly update: ValidateUpdate<S, K>;
  }
}

export { v } from "./rules.js";
export type { Rule } from "./rules.js";
