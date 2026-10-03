import { tag, type Containment } from "../operators.js";

/**
 * Contained by (`<@`) for an array, jsonb, or range column.
 *
 * @typeParam V - Operand
 * @param value - Containing value
 * @returns A tagged operator
 */
export function containedBy<const V>(value: V): Containment<"containedBy", V> {
  return tag("containedBy", value);
}
