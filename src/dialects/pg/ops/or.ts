import { tag, type Or } from "../operators.js";

/**
 * Disjunction of where objects.
 *
 * @typeParam V - One branch
 * @param branches - Where objects, or-ed
 * @returns A tagged operator
 */
export function or<const V>(branches: readonly V[]): Or<V> {
  return tag("or", branches);
}
