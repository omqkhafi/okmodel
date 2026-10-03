import { tag, type HasAnyKey } from "../operators.js";

/**
 * jsonb key existence for any of `keys`. Compiled as `jsonb_exists_any`.
 *
 * @param keys - Object keys
 * @returns A tagged operator
 */
export function hasAnyKey(keys: readonly string[]): HasAnyKey {
  return tag("hasAnyKey", keys);
}
