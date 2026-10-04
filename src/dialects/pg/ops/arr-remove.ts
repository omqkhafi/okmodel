import { tag, type ArrRemove } from "../operators.js";

/**
 * Removes every equal element (`array_remove`).
 *
 * @typeParam V - Element
 * @param value - Element to remove
 * @returns A tagged operator
 */
export function remove<const V>(value: V): ArrRemove<V> {
  return tag("arr.remove", value);
}
