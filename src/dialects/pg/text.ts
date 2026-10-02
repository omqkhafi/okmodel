/**
 * Text, varchar, char, and citext.
 */

import { type ColumnBuilder, type PlainFlags, required } from "./column.js";
import { definition, rejected } from "./misuse.js";

/**
 * Unbounded text.
 *
 * @returns A text column
 */
export function text(): ColumnBuilder<string, PlainFlags> {
  return required({ baseType: "text", encode: encodeText, decode: decodeText, sqlForm: "quote" });
}

/**
 * Bounded text. The TypeScript type stays `string`. Encode rejects a longer value.
 *
 * @param length - Maximum characters, at least 1
 * @returns A varchar column
 */
export function varchar(length: number): ColumnBuilder<string, PlainFlags> {
  const limit = boundedLength(length, "varchar");
  return required({
    baseType: `varchar(${String(limit)})`,
    encode: (value) => encodeLimited(value, limit, "varchar"),
    decode: decodeText,
    sqlForm: "quote",
  });
}

/**
 * Fixed-length character. Encode rejects a longer value and does not pad.
 *
 * @param length - Characters, at least 1
 * @returns A char column
 */
export function char(length: number): ColumnBuilder<string, PlainFlags> {
  const limit = boundedLength(length, "char");
  return required({
    baseType: `char(${String(limit)})`,
    encode: (value) => encodeLimited(value, limit, "char"),
    decode: decodeText,
    sqlForm: "quote",
  });
}

/**
 * Case-insensitive text. The column depends on the `citext` extension.
 *
 * @returns A citext column
 */
export function citext(): ColumnBuilder<string, PlainFlags> {
  return required({
    baseType: "citext",
    encode: encodeText,
    decode: decodeText,
    sqlForm: "quote",
    extension: "citext",
  });
}

/**
 * Returns text unchanged.
 *
 * @param value - Text
 * @returns The same text
 */
export function encodeText(value: string): string {
  return value;
}

/**
 * Returns wire text unchanged.
 *
 * @param wire - Text
 * @returns The same text
 */
export function decodeText(wire: string): string {
  return wire;
}

function encodeLimited(value: string, limit: number, role: string): string {
  if (characterLength(value) > limit) {
    rejected(`${role} accepts at most ${String(limit)} characters.`);
  }
  return value;
}

function boundedLength(length: number, role: string): number {
  if (!Number.isInteger(length) || length < 1 || length > 10_485_760) {
    definition(`${role} length ${String(length)} must be an integer from 1 to 10485760.`);
  }
  return length;
}

function characterLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      index += 1;
    }
    count += 1;
  }
  return count;
}
