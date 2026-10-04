import { tag, type JsonSet } from "../operators.js";

/**
 * Atomic JSON path write, the `set` member of the `json` namespace (spec §11).
 *
 * The path is bound as `text[]` and the value as jsonb.
 *
 * @typeParam V - New value
 * @param path - Path, one segment per element
 * @param value - Value stored at that path
 * @returns A tagged operator
 */
export function set<const V>(path: readonly string[], value: V): JsonSet<V> {
  return tag("json.set", { path, value });
}
