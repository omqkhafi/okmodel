import { tag, type Pattern } from "../operators.js";

/**
 * Case-sensitive suffix. `%`, `_`, and `\` in `value` are escaped.
 *
 * @param value - Literal suffix
 * @returns A tagged operator
 */
export function endsWith(value: string): Pattern<"endsWith"> {
  return tag("endsWith", value);
}
