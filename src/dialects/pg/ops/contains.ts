import { tag, type Pattern } from "../operators.js";

/**
 * Case-sensitive substring. `%`, `_`, and `\` in `value` are escaped.
 *
 * @param value - Literal substring
 * @returns A tagged operator
 */
export function contains(value: string): Pattern<"contains"> {
  return tag("contains", value);
}
