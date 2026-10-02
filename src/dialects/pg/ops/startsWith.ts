import { tag, type Pattern } from "../operators.js";

/**
 * Case-sensitive prefix. `%`, `_`, and `\` in `value` are escaped.
 *
 * @param value - Literal prefix
 * @returns A tagged operator
 */
export function startsWith(value: string): Pattern<"startsWith"> {
  return tag("startsWith", value);
}
