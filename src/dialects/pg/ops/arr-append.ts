import { tag, type ArrAppend } from "../operators.js";

/**
 * Appends one element (`array_append`).
 *
 * @typeParam V - Element
 * @param value - Element to add
 * @returns A tagged operator
 */
export function append<const V>(value: V): ArrAppend<V> {
  return tag("arr.append", value);
}
