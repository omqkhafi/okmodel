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
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char.length === 2) {
      out += hexEscape(char.charCodeAt(0));
      out += hexEscape(char.charCodeAt(1));
      continue;
    }
    if (code === 0x22) {
      out += '\\"';
    } else if (code === 0x5c) {
      out += "\\\\";
    } else if (code === 0x08) {
      out += "\\b";
    } else if (code === 0x0c) {
      out += "\\f";
    } else if (code === 0x0a) {
      out += "\\n";
    } else if (code === 0x0d) {
      out += "\\r";
    } else if (code === 0x09) {
      out += "\\t";
    } else if (code < 0x20 || code > 0x7e) {
      out += hexEscape(code);
    } else {
      out += char;
    }
  }
  out += '"';
  return out;
}

function hexEscape(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}
