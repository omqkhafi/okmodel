import { tag, type Adjacent } from "../operators.js";

/**
 * Adjacent ranges (`-|-`).
 *
 * @typeParam V - Operand
 * @param value - Range that touches the column
 * @returns A tagged operator
 */
export function adjacent<const V>(value: V): Adjacent<V> {
  return tag("adjacent", value);
}
