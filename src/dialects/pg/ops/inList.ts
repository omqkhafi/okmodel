import { tag, type InList } from "../operators.js";

/**
 * Membership. An empty list matches nothing and does not become `IN ()`.
 *
 * @typeParam V - Element
 * @param values - Accepted values
 * @returns A tagged operator
 */
export function inList<const V>(values: readonly V[]): InList<V> {
  return tag("inList", values);
}
