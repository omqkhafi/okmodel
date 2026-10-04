import { tag, type Path, type PathCompare } from "../operators.js";

/**
 * Compares the text at `segments` (`#>>`) with `op`.
 *
 * The operand of `op` picks the cast: number to numeric, boolean to boolean,
 * string to text. Segments are bound as `text[]`.
 *
 * @typeParam V - Compared value
 * @param segments - Path, one segment per element
 * @param op - Comparison. `eq`, `lt`, `lte`, `gt`, or `gte`
 * @returns A tagged operator
 */
export function path<const V extends string | number | boolean>(
  segments: readonly string[],
  op: PathCompare<V>,
): Path<V> {
  return tag("path", { segments, op });
}
