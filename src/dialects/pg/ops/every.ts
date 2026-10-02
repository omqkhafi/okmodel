import { tag, type RelationFilter } from "../operators.js";

/**
 * Every related row matches. True when there are no related rows.
 *
 * @typeParam V - Related where
 * @param where - Filter on the related table
 * @returns A relation filter
 */
export function every<const V>(where: V): RelationFilter<"every", V> {
  return tag("every", where);
}
