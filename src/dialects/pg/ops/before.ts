import { tag, type Before } from "../operators.js";

/**
 * Strictly before (`<<`).
 *
 * @typeParam V - Operand
 * @param value - Range that starts after the column ends
 * @returns A tagged operator
 */
export function before<const V>(value: V): Before<V> {
  return tag("before", value);
}
