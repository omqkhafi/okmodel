/**
 * Canonical JSON.
 *
 * Object keys are sorted. Strings are ASCII-only escapes, so the same value
 * produces the same bytes on every runtime. Arrays keep their order.
 */

import { catalogError } from "../error.js";

/** JSON values the canonical encoder accepts. Numbers are safe integers. */
export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json | undefined };

/**
 * Encodes a value with object keys sorted at every level.
 *
 * @param value - JSON value
 * @returns Canonical text
 */
export function canonicalJson(value: Json): string {
  return encode(value);
}

function encode(value: Json): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      catalogError("OKM1020", "Catalog JSON cannot encode a non-integer number.");
    }
    return String(value);
  }
  if (typeof value === "string") {
    return encodeString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => encode(item)).join(",")}]`;
  }
  if (!isJsonRecord(value)) {
    catalogError("OKM1020", "Catalog JSON cannot encode this value.");
  }
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const item = value[key];
    if (item === undefined) {
      continue;
    }
    parts.push(`${encodeString(key)}:${encode(item)}`);
  }
  return `{${parts.join(",")}}`;
}

function isJsonRecord(value: Json): value is { readonly [key: string]: Json | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeString(value: string): string {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code < 0x20 || code > 0x7e) {
      return encodeEscaped(value);
    }
  }
  return `"${value}"`;
}

function encodeEscaped(value: string): string {
  const parts: string[] = ['"'];
  let start = 0;
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    const next = value.charCodeAt(index + 1);
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      if (index > start) {
        parts.push(value.slice(start, index));
      }
      parts.push(hexEscape(code), hexEscape(next));
      index += 2;
      start = index;
      continue;
    }
    if (needsEscape(code)) {
      if (index > start) {
        parts.push(value.slice(start, index));
      }
      parts.push(escapeUnit(code));
      index += 1;
      start = index;
      continue;
    }
    index += 1;
  }
  if (start < value.length) {
    parts.push(value.slice(start));
  }
  parts.push('"');
  return parts.join("");
}

function needsEscape(code: number): boolean {
  return code === 0x22 || code === 0x5c || code < 0x20 || code > 0x7e;
}

function escapeUnit(code: number): string {
  if (code === 0x22) {
    return '\\"';
  }
  if (code === 0x5c) {
    return "\\\\";
  }
  if (code === 0x08) {
    return "\\b";
  }
  if (code === 0x0c) {
    return "\\f";
  }
  if (code === 0x0a) {
    return "\\n";
  }
  if (code === 0x0d) {
    return "\\r";
  }
  if (code === 0x09) {
    return "\\t";
  }
  return hexEscape(code);
}

function hexEscape(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}
