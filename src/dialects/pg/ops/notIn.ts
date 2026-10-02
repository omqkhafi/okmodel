import { tag, type NotIn } from "../operators.js";

/**
 * Complement of {@link inList}. An empty list matches everything.
 *
 * @typeParam V - Element
 * @param values - Rejected values
 * @returns A tagged operator
 */
export function notIn<const V>(values: readonly V[]): NotIn<V> {
  return tag("notIn", values);
}
