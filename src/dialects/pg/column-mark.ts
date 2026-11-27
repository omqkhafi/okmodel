/**
 * The symbol a composite encode function carries.
 *
 * The read path and the write path share it. It stays out of `column.ts` so a
 * connect entry can read the mark without loading column codecs.
 */

import type { CompositeMark } from "./composite-mark.js";

const COMPOSITE = Symbol.for("okmodel.composite");

/**
 * Reads the composite mark stored on an encode function.
 *
 * @param encode - Column encode
 * @returns The mark, or `undefined` when the column is not a composite
 */
export function compositeMark(encode: (...args: never[]) => string): CompositeMark | undefined {
  return (encode as { readonly [COMPOSITE]?: CompositeMark })[COMPOSITE];
}

/**
 * Stores a composite mark on an encode function.
 *
 * @param encode - Encode to tag
 * @param mark - Mark the read and write paths read back
 * @returns The same function
 */
export function tagComposite<T extends (value: unknown) => string>(
  encode: T,
  mark: CompositeMark,
): T {
  (encode as { [COMPOSITE]?: CompositeMark })[COMPOSITE] = mark;
  return encode;
}
