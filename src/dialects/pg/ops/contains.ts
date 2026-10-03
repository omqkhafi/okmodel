import { tag, type Tagged } from "../operators.js";

/**
 * Substring on text, or containment (`@>`) on an array, jsonb, or range.
 *
 * On text, `%`, `_`, and `\` in `value` are escaped. On the other types the
 * value is a parameter cast to the column type.
 *
 * @typeParam V - Operand
 * @param value - Substring or contained value
 * @returns A tagged operator
 */
export function contains<const V>(value: V): Tagged<"contains", V> {
  return tag("contains", value);
}
