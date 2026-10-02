import { tag, type Compare } from "../operators.js";

/**
 * Less than.
 *
 * @typeParam V - Operand
 * @param value - Upper bound, exclusive
 * @returns A tagged operator
 */
export function lt<const V>(value: V): Compare<"lt", V> {
  return tag("lt", value);
}
