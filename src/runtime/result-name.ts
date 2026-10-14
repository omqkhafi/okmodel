/**
 * Result keys a caller chooses.
 *
 * Loaded with the bucket chunk and the window chunk (D258). The startup
 * graph does not import it.
 */

import { fail } from "./plan.js";

/**
 * Names that shadow or replace a property on `Object.prototype`.
 *
 * The same four `filters().parse` treats as ordinary keys (D215).
 */
const PROTOTYPE_KEYS = ",__proto__,constructor,toString,hasOwnProperty,";

/**
 * Refuses a result key that would shadow or replace a prototype property.
 *
 * Assigning `__proto__` replaces that object's prototype when the value is an
 * object. `constructor`, `toString`, and `hasOwnProperty` shadow the methods
 * on the row. The check runs before any SQL.
 *
 * @param name - The result key
 * @param where - The call, such as `rowNumber as` or `bucket as`
 */
export function refusePrototypeKey(name: string, where: string): void {
  if (!PROTOTYPE_KEYS.includes(`,${name},`)) return;
  fail("OKM1120", `${where} ${name} is a prototype key. Use another name for the result.`);
}
