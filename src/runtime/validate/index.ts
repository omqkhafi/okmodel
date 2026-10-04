/**
 * Validation rules (`okmodel/validate`).
 *
 * Importing this module registers the client hook. An application that does
 * not import it does not load the hook or the engine.
 */

import { armValidation } from "./bind.js";

armValidation();

export { v } from "./rules.js";
export type { Rule } from "./rules.js";
