import { tag, type Compare } from "../operators.js";

/**
 * Greater than.
 *
 * @typeParam V - Operand
 * @param value - Lower bound, exclusive
 * @returns A tagged operator
 */
export function gt<const V>(value: V): Compare<"gt", V> {
  return tag("gt", value);
}
