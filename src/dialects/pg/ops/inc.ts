import { tag, type Tagged } from "../operators.js";

/** Adds to the stored number. `undefined` in `set` still leaves the field unchanged. */
export type Inc<V> = Tagged<"inc", V>;

/**
 * Adds to a stored number in `update` `set` (spec §11).
 *
 * A null number stays null. JSON and array operators are not this helper.
 *
 * @typeParam V - Amount
 * @param value - Amount to add
 * @returns A tagged operator
 */
export function inc<const V>(value: V): Inc<V> {
  return tag("inc", value);
}
