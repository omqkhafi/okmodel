import { tag, type HasKey } from "../operators.js";

/**
 * jsonb key existence. Compiled as `jsonb_exists`, so `?` never enters SQL text.
 *
 * @param key - Object key
 * @returns A tagged operator
 */
export function hasKey(key: string): HasKey {
  return tag("hasKey", key);
}
