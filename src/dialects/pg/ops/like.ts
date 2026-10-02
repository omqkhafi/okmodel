import { tag, type RawPattern } from "../operators.js";

/**
 * Raw `LIKE` pattern. Wildcards are not escaped.
 *
 * @param pattern - Pattern the caller wrote
 * @returns A tagged operator
 */
export function like(pattern: string): RawPattern<"like"> {
  return tag("like", pattern);
}
