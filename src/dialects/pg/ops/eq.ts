import { tag, type Eq } from "../operators.js";

/**
 * Equality. This is the form for json and jsonb (D125).
 *
 * @typeParam V - Operand
 * @param value - Value to compare
 * @returns A tagged operator
 */
export function eq<const V>(value: V): Eq<V> {
  return tag("eq", value);
}
