/**
 * A column whose SQL type and codec are supplied by the caller.
 *
 * The spec writes `tsType` in the options object. The type parameter is that
 * type; a runtime `tsType` field cannot carry it.
 */

import { type ColumnBuilder, type PlainFlags, type SqlForm, required } from "./column.js";
import { definition } from "./misuse.js";

/**
 * Custom column.
 *
 * @typeParam TValue - TypeScript value
 * @param spec - SQL type, codec, and optional extension
 * @returns A column using that codec
 */
export function custom<TValue>(spec: {
  readonly sqlType: string;
  readonly encode: (value: TValue) => string;
  readonly decode: (wire: string) => TValue;
  readonly extension?: string;
  readonly sqlForm?: SqlForm;
}): ColumnBuilder<TValue, PlainFlags> {
  if (spec.sqlType.length === 0) {
    definition("custom sqlType must be a non-empty SQL type.");
  }
  return required({
    baseType: spec.sqlType,
    encode: spec.encode,
    decode: spec.decode,
    sqlForm: spec.sqlForm ?? "quote",
    ...(spec.extension !== undefined ? { extension: spec.extension } : {}),
  });
}
