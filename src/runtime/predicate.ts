/**
 * Whether a `where` constrains a row.
 *
 * Write and archive load this module. A read does not. The walk is the same
 * one those paths used when it lived in the planner.
 */

import { isOperator, operatorName, operatorValue } from "../dialects/pg/operators.js";
import { isRecord, orFail } from "./plan.js";

/**
 * Whether `where` constrains a row.
 *
 * A field value is a leaf. Anything other than `undefined` counts, including
 * `null`, objects, arrays, and operators. The walk does not enter a field value.
 * It enters the where object's own keys, `and`, `or`, and `not` when `not` is
 * the where itself. An `or()` branch with no predicate is OKM1121. `or([])`
 * matches nothing.
 *
 * @param where - Caller filter, or one `and` / `or` / `not` operand
 * @returns `false` when the filter matches every row
 */
export function effectivePredicate(where: unknown): boolean {
  if (where === undefined) return false;
  if (isOperator(where)) {
    const name = operatorName(where);
    const value = operatorValue(where);
    if (name === "or") {
      if (!Array.isArray(value)) orFail(false);
      if (value.length === 0) return true;
      for (const branch of value) {
        if (!effectivePredicate(branch)) orFail(true);
      }
      return true;
    }
    if (name === "and") {
      return Array.isArray(value) && value.some((part) => effectivePredicate(part));
    }
    if (name === "not") return effectivePredicate(value);
    return true;
  }
  if (!isRecord(where)) return true;
  for (const key of Object.keys(where)) {
    if (where[key] !== undefined) return true;
  }
  return false;
}
