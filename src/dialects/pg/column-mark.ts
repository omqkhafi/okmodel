/**
 * The symbol a composite encode function carries.
 *
 * The read path and the write path share it. It stays out of `column.ts` so a
 * connect entry can read the mark without loading column codecs.
 */

import type { CatalogObject, Namespace, Provenance } from "../../contracts/catalog/types.js";
import type { CompositeMark } from "./composite-mark.js";

const COMPOSITE = Symbol.for("okmodel.composite");

const RANGE = Symbol.for("okmodel.range");

/**
 * What a range column tells the planner.
 *
 * The encode function carries it. A featureless app never builds one, so the
 * tuple codec and the range operators stay out of that bundle.
 */
export type RangeColumnMark = {
  readonly kind: "range" | "multirange";
  readonly type: string;
  readonly subtype: string;
  /** SQL function that subtracts two bounds. Absent when the type has none. */
  readonly subtypeDiff?: string;
  readonly collation?: string;
  readonly multirange: string;
  readonly renamedFrom?: string;
  readonly comment?: string;
  readonly grants?: unknown;
  readonly quote: boolean;
  readonly encodeBound: (value: unknown) => string;
  readonly read?: (sql: string) => string;
  emit?(
    parent: { readonly namespace: Namespace },
    provenance: Provenance,
    objects: CatalogObject[],
    column: string,
    nullable: boolean,
  ): void;
  asArray(dims: number): {
    readonly encode: (value: unknown) => string;
    readonly decode: (wire: string) => unknown;
  };
  multi(): {
    readonly baseType: string;
    readonly encode: (value: unknown) => string;
    readonly decode: (wire: string) => unknown;
  };
};

/**
 * Reads the range mark stored on an encode function.
 *
 * @param encode - Column encode
 * @returns The mark, or `undefined` when the column is not a range
 */
export function rangeMark(encode: (...args: never[]) => string): RangeColumnMark | undefined {
  return (encode as { readonly [RANGE]?: RangeColumnMark })[RANGE];
}

/**
 * Stores a range mark on an encode function.
 *
 * @param encode - Encode to tag
 * @param mark - Mark the read and write paths read back
 * @returns The same function
 */
export function tagRange<T extends (value: unknown) => string>(
  encode: T,
  mark: RangeColumnMark,
): T {
  (encode as { [RANGE]?: RangeColumnMark })[RANGE] = mark;
  return encode;
}

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
