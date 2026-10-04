/**
 * boolean and bytea.
 */

import { type ColumnBuilder, type PlainFlags, required } from "./column.js";
import { rejected } from "./misuse.js";

/**
 * Boolean.
 *
 * @returns A boolean column
 */
export function boolean(): ColumnBuilder<boolean, PlainFlags> {
  return required({
    baseType: "boolean",
    encode: encodeBoolean,
    decode: decodeBoolean,
    sqlForm: "raw",
  });
}

/**
 * Binary data. Wire text is `\x` plus lowercase hex.
 *
 * @returns A bytea column
 */
export function bytea(): ColumnBuilder<Uint8Array, PlainFlags> {
  return required({
    baseType: "bytea",
    encode: encodeBytea,
    decode: decodeBytea,
    accepts: ["Uint8Array"],
    sqlForm: "quote",
  });
}

/**
 * Encodes true or false.
 *
 * @param value - Boolean
 * @returns `true` or `false`
 */
export function encodeBoolean(value: boolean): string {
  return value ? "true" : "false";
}

/**
 * Decodes a boolean token.
 *
 * Accepts `true`, `false`, `t`, `f`, `1`, and `0`.
 *
 * @param wire - Boolean text
 * @returns A boolean
 */
export function decodeBoolean(wire: string): boolean {
  if (wire === "true" || wire === "t" || wire === "1") {
    return true;
  }
  if (wire === "false" || wire === "f" || wire === "0") {
    return false;
  }
  rejected(`boolean ${wire} must be true, false, t, f, 1, or 0.`);
}

/**
 * Encodes bytes as `\x` hex.
 *
 * @param value - Bytes
 * @returns Hex text
 */
export function encodeBytea(value: Uint8Array): string {
  let hex = "";
  for (const byte of value) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `\\x${hex}`;
}

/**
 * Decodes `\x` hex into a new byte array.
 *
 * @param wire - Hex text
 * @returns Bytes
 */
export function decodeBytea(wire: string): Uint8Array {
  if (!wire.startsWith("\\x") || (wire.length - 2) % 2 !== 0) {
    rejected(`bytea ${wire} must be \\x followed by an even number of hex digits.`);
  }
  const bytes = new Uint8Array((wire.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const hex = wire.slice(2 + index * 2, 4 + index * 2);
    const byte = Number.parseInt(hex, 16);
    if (!hexText().test(hex) || Number.isNaN(byte)) {
      rejected(`bytea ${wire} must be \\x followed by an even number of hex digits.`);
    }
    bytes[index] = byte;
  }
  return bytes;
}

function hexText(): RegExp {
  hexPattern ??= /^[0-9a-f]{2}$/i;
  return hexPattern;
}

let hexPattern: RegExp | undefined;
