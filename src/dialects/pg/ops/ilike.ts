import { tag, type RawPattern } from "../operators.js";

/**
 * Raw `ILIKE` pattern. Wildcards are not escaped.
 *
 * @param pattern - Pattern the caller wrote
 * @returns A tagged operator
 */
export function ilike(pattern: string): RawPattern<"ilike"> {
  return tag("ilike", pattern);
}
