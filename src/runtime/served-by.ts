/**
 * Which replica answered a read.
 *
 * The topology router records the replica's configured name against the result
 * it got back. The query observer reads it to label the route a statement
 * really took. A result from the primary is not recorded.
 */

/** Result object to the name of the replica that produced it. */
export const servedBy: WeakMap<object, string> = new WeakMap();
