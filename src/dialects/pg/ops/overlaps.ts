import { tag, type Overlaps } from "../operators.js";

/**
 * Overlap (`&&`) for an array or range column.
 *
 * @typeParam V - Operand
 * @param value - Value that must overlap the column
 * @returns A tagged operator
 */
export function overlaps<const V>(value: V): Overlaps<V> {
  return tag("overlaps", value);
}
