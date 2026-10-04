/**
 * Registers the validation hook.
 *
 * Called when `okmodel/validate` is imported and again from each `v` rule,
 * so a bundler that drops the module side effect still registers the hook
 * before `schema()` when the app builds a rule first.
 */

import { addSchemaHook } from "../../dialects/pg/schema.js";
import { attachValidation } from "./hook.js";

let armed = false;

/**
 * Adds the validation hook to schemas compiled after this call.
 */
export function armValidation(): void {
  if (armed) return;
  armed = true;
  addSchemaHook(attachValidation);
}
