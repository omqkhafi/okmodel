/**
 * json, jsonb, and the bigint JSON replacer.
 */

import { type ColumnBuilder, type PlainFlags, required } from "./column.js";
import { rejected } from "./misuse.js";

/**
 * `JSON.stringify` replacer that writes bigint as a decimal string.
 *
 * `JSON.stringify` throws on a bigint. Projects that choose `bigint: "bigint"`
 * pass this to `JSON.stringify`.
 *
 * @param _key - Property name. Unused
 * @param value - Value about to be serialised
 * @returns A string for bigint, otherwise the value
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

/**
 * JSON text. `T` is the TypeScript shape; the codec does not check it.
 *
 * @typeParam T - JSON value type
 * @returns A json column
 */
export function json<T = unknown>(): ColumnBuilder<T, PlainFlags> {
  return required({
    baseType: "json",
    encode: encodeJson,
    decode: decodeJson as (wire: string) => T,
    sqlForm: "json",
  });
}

/**
 * Binary JSON. `T` is the TypeScript shape; the codec does not check it.
 *
 * @typeParam T - JSON value type
 * @returns A jsonb column
 */
export function jsonb<T = unknown>(): ColumnBuilder<T, PlainFlags> {
  return required({
    baseType: "jsonb",
    encode: encodeJson,
    decode: decodeJson as (wire: string) => T,
    sqlForm: "jsonb",
  });
}

/**
 * Encodes JSON. Bigint values become decimal strings.
 *
 * @param value - JSON value
 * @returns JSON text
 */
export function encodeJson(value: unknown): string {
  const text = JSON.stringify(value, jsonReplacer);
  if (text === undefined) {
    rejected(
      "json value must be JSON data. undefined and functions are not accepted. bigint is written as a decimal string.",
    );
  }
  return text;
}

/**
 * Decodes JSON text.
 *
 * @param wire - JSON text
 * @returns The parsed value
 */
export function decodeJson(wire: string): unknown {
  try {
    return JSON.parse(wire) as unknown;
  } catch {
    rejected("json text must be JSON, for example null, a string, a number, true, {}, or [].");
  }
}
