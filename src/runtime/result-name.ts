/**
 * Result keys a caller chooses.
 *
 * Loaded with the bucket chunk and the window chunk (D258). The startup
 * graph does not import it.
 */

import { fail } from "./plan.js";

/**
 * Names that shadow or replace a property on `Object.prototype`, plus `then`.
 *
 * `__proto__`, `constructor`, `toString`, and `hasOwnProperty` are the four
 * `filters().parse` treats as ordinary keys (D215). The rest of
 * `Object.prototype` is refused here too, and so is `then`.
 */
const PROTOTYPE_KEYS =
  ",__proto__,constructor,toString,hasOwnProperty,valueOf,isPrototypeOf,propertyIsEnumerable,toLocaleString,__defineGetter__,__defineSetter__,__lookupGetter__,__lookupSetter__,then,";

/**
 * Refuses a result key that would shadow or replace a prototype property.
 *
 * Assigning `__proto__` replaces that object's prototype when the value is an
 * object. The other names shadow methods on the row. `then` makes the row a
 * thenable. The check runs before any SQL.
 *
 * @param name - The result key
 * @param where - The call, such as `rowNumber as` or `bucket as`
 */
export function refusePrototypeKey(name: string, where: string): void {
  if (!PROTOTYPE_KEYS.includes(`,${name},`)) return;
  fail("OKM1120", `${where} ${name} is a prototype key. Use another name for the result.`);
}
