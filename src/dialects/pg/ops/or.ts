import { OkmError } from "../../../contracts/error.js";
import { tag, type Or } from "../operators.js";

/**
 * Disjunction of where objects.
 *
 * @typeParam V - One branch
 * @param branches - Where objects, or-ed. One array: `or([a, b])`
 * @returns A tagged operator
 */
export function or<const V>(branches: readonly V[]): Or<V> {
  if (arguments.length !== 1 || !Array.isArray(branches)) {
    throw new OkmError("OKM1121", "Pass an array: or([a, b]).", {
      fix: { summary: "Pass an array: or([a, b])." },
    });
  }
  return tag("or", branches);
}
