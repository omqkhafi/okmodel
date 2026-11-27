import { tag, type IsEmpty } from "../operators.js";

/**
 * `isempty`.
 *
 * @param value - `true` matches an empty range. `false` matches the rest
 * @returns A tagged operator
 */
export function isEmpty(value: boolean = true): IsEmpty {
  return tag("isEmpty", value);
}
