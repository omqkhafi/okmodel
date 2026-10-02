import { tag, type Compare } from "../operators.js";

/**
 * Less than or equal.
 *
 * @typeParam V - Operand
 * @param value - Upper bound, inclusive
 * @returns A tagged operator
 */
export function lte<const V>(value: V): Compare<"lte", V> {
  return tag("lte", value);
}
