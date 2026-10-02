import { tag, type RelationFilter } from "../operators.js";

/**
 * No related row matches.
 *
 * @typeParam V - Related where
 * @param where - Filter on the related table
 * @returns A relation filter
 */
export function none<const V>(where: V): RelationFilter<"none", V> {
  return tag("none", where);
}
