import { tag, type After } from "../operators.js";

/**
 * Strictly after (`>>`).
 *
 * @typeParam V - Operand
 * @param value - Range that ends before the column starts
 * @returns A tagged operator
 */
export function after<const V>(value: V): After<V> {
  return tag("after", value);
}
