import { tag, type RelationFilter } from "../operators.js";

/**
 * Related rows exist.
 *
 * @typeParam V - Related where
 * @param where - Filter on the related table
 * @returns A relation filter
 */
export function has<const V>(where: V): RelationFilter<"has", V> {
  return tag("has", where);
}
