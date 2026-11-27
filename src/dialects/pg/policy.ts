/**
 * Policy compiler (`okmodel/policy`).
 *
 * Import this module in the file that calls `schema()` when a table sets
 * `policies` or `rls`. Loading it installs the compiler. `okmodel/session`
 * does not.
 */

import { compileUserPolicies } from "./policy-compile.js";

export { compileUserPolicies };
