import { tag, type Not } from "../operators.js";

/**
 * Negation. `not(null)` is `IS NOT NULL`.
 *
 * @typeParam V - Operand
 * @param value - Null, a value, or another operator
 * @returns A tagged operator
 */
export function not<const V>(value: V): Not<V> {
  return tag("not", value);
}
