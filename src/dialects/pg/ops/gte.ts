import { tag, type Compare } from "../operators.js";

/**
 * Greater than or equal.
 *
 * @typeParam V - Operand
 * @param value - Lower bound, inclusive
 * @returns A tagged operator
 */
export function gte<const V>(value: V): Compare<"gte", V> {
  return tag("gte", value);
}
