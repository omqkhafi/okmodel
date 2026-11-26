/**
 * Conjunction of where objects.
 *
 * The query planner already unwraps an operator named `and`. This is the
 * public form, next to `or`.
 */

import { OkmError } from "../../../contracts/error.js";
import { tag, type And } from "../operators.js";

/**
 * Conjunction of where objects.
 *
 * @typeParam V - One branch
 * @param branches - Where objects, and-ed. One array: `and([a, b])`
 * @returns A tagged operator
 */
export function and<const V>(branches: readonly V[]): And<V> {
  if (arguments.length !== 1 || !Array.isArray(branches)) {
    throw new OkmError("OKM1121", "Pass an array: and([a, b]).", {
      fix: { summary: "Pass an array: and([a, b])." },
    });
  }
  return tag("and", branches);
}
