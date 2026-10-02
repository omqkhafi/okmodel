import { tag, type Between } from "../operators.js";

/**
 * Inclusive range.
 *
 * @typeParam V - Operand
 * @param from - Lower bound
 * @param to - Upper bound
 * @returns A tagged operator
 */
export function between<const V>(from: V, to: V): Between<V> {
  return tag("between", [from, to] as const);
}
