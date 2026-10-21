/**
 * RFC 8785 canonical JSON for the values a plan hash stores.
 *
 * Object keys sort by UTF-16 code unit. Strings escape controls as
 * lowercase `\u00xx`, not as `\n`. `-0` is `0`. A non-finite number is
 * refused. Integers inside the safe range have no exponent.
 */

import { sha256 } from "../contracts/sha256.js";

/** Values the canonicaliser accepts. */
export type Canonical =
  | null
  | boolean
  | number
  | string
  | readonly Canonical[]
  | { readonly [key: string]: Canonical };

/**
 * Serialises one value with no insignificant whitespace.
 *
 * @param value - JSON value
 * @returns Canonical text
 */
export function canonicalJson(value: Canonical): string {
  return write(value);
}

/**
 * SHA-256 of {@link canonicalJson}.
 *
 * @param value - JSON value
 * @returns Lowercase hex
 */
export function canonicalHash(value: Canonical): string {
  return sha256(canonicalJson(value));
}

function write(value: Canonical): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return writeNumber(value);
  if (typeof value === "string") return writeString(value);
  if (Array.isArray(value)) return `[${value.map((item) => write(item)).join(",")}]`;
  const record = value as { readonly [key: string]: Canonical };
  const keys = Object.keys(record).sort(compareUtf16);
  return `{${keys.map((key) => `${writeString(key)}:${write(record[key] as Canonical)}`).join(",")}}`;
}

function writeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("canonical JSON rejects a non-finite number");
  if (Object.is(value, -0)) return "0";
  if (Number.isSafeInteger(value)) return String(value);
  return JSON.stringify(value);
}

function writeString(value: string): string {
  let out = '"';
  for (const char of value) {
    const point = char.codePointAt(0) ?? 0;
    if (point === 0x22 || point === 0x5c) {
      out += `\\${char}`;
      continue;
    }
    if (point < 0x20) {
      out += `\\u${point.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += char;
  }
  return `${out}"`;
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
