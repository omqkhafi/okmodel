/**
 * Postgres range columns.
 *
 * A range is either empty or a pair of bounds. Unbounded sides use null.
 */

import { type ColumnBuilder, type PlainFlags, required } from "./column.js";
import { encodeNumericString, decodeNumericString } from "./decimal.js";
import { decodeBigintString, encodeBigintString, integerToken } from "./integer.js";
import { rejected } from "./misuse.js";
import { decodeDate, decodeInstant, encodeDate, encodeInstant } from "./temporal.js";

/**
 * A range value.
 *
 * @typeParam T - Bound type
 */
export type Range<T> =
  | { readonly empty: true }
  | {
      readonly empty: false;
      readonly lower: T | null;
      readonly upper: T | null;
      readonly lowerInclusive: boolean;
      readonly upperInclusive: boolean;
    };

/**
 * Timestamp with time zone range.
 *
 * @returns A tstzrange column
 */
export function tstzrange(): ColumnBuilder<Range<Temporal.Instant>, PlainFlags> {
  return rangeColumn("tstzrange", encodeInstant, decodeInstant, true);
}

/**
 * Date range.
 *
 * @returns A daterange column
 */
export function daterange(): ColumnBuilder<Range<Temporal.PlainDate>, PlainFlags> {
  return rangeColumn("daterange", encodeDate, decodeDate, true);
}

/**
 * 32-bit integer range.
 *
 * @returns An int4range column
 */
export function int4range(): ColumnBuilder<Range<number>, PlainFlags> {
  return rangeColumn(
    "int4range",
    (value) => integerToken(value, -2_147_483_648, 2_147_483_647, "int4range"),
    (wire) => decodeBoundNumber(wire, "int4range"),
    false,
  );
}

/**
 * 64-bit integer range. Bounds are decimal strings.
 *
 * @returns An int8range column
 */
export function int8range(): ColumnBuilder<Range<string>, PlainFlags> {
  return rangeColumn("int8range", encodeBigintString, decodeBigintString, false);
}

/**
 * Numeric range. Bounds are decimal strings.
 *
 * @returns A numrange column
 */
export function numrange(): ColumnBuilder<Range<string>, PlainFlags> {
  return rangeColumn("numrange", encodeNumericString, decodeNumericString, false);
}

function rangeColumn<T>(
  baseType: string,
  encodeBound: (value: T) => string,
  decodeBound: (wire: string) => T,
  quote: boolean,
): ColumnBuilder<Range<T>, PlainFlags> {
  return required({
    baseType,
    encode: (value) => writeRange(value, encodeBound, quote),
    decode: (wire) => readRange(wire, decodeBound, quote),
    accepts: ["Object"],
    sqlForm: "cast",
  });
}

function writeRange<T>(value: Range<T>, encodeBound: (value: T) => string, quote: boolean): string {
  if (value.empty) {
    return "empty";
  }
  if (value.empty !== false) {
    rejected("range needs empty: true, or empty: false with lower and upper.");
  }
  const lower = value.lower === null ? "" : boundText(encodeBound(value.lower), quote);
  const upper = value.upper === null ? "" : boundText(encodeBound(value.upper), quote);
  const open = value.lowerInclusive ? "[" : "(";
  const close = value.upperInclusive ? "]" : ")";
  return `${open}${lower},${upper}${close}`;
}

function boundText(encoded: string, quote: boolean): string {
  if (!quote) {
    return encoded;
  }
  return `"${encoded.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function readRange<T>(wire: string, decodeBound: (wire: string) => T, quote: boolean): Range<T> {
  if (wire === "empty") {
    return { empty: true };
  }
  const open = wire[0];
  const close = wire[wire.length - 1];
  if ((open !== "[" && open !== "(") || (close !== "]" && close !== ")")) {
    rejected(`range ${wire} is not a range literal.`);
  }
  const body = wire.slice(1, -1);
  const split = splitBound(body);
  if (split === undefined) {
    rejected(`range ${wire} is not a range literal.`);
  }
  return {
    empty: false,
    lowerInclusive: open === "[",
    upperInclusive: close === "]",
    lower: split.lower.length === 0 ? null : decodeBound(unquote(split.lower, quote)),
    upper: split.upper.length === 0 ? null : decodeBound(unquote(split.upper, quote)),
  };
}

function splitBound(body: string): { readonly lower: string; readonly upper: string } | undefined {
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      return { lower: body.slice(0, index), upper: body.slice(index + 1) };
    }
  }
  return undefined;
}

function unquote(token: string, quote: boolean): string {
  if (!quote) {
    return token;
  }
  if (!token.startsWith('"') || !token.endsWith('"')) {
    rejected(`range bound ${token} is not quoted.`);
  }
  return token.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

function decodeBoundNumber(wire: string, role: string): number {
  const value = Number(wire);
  integerToken(value, -2_147_483_648, 2_147_483_647, role);
  return value;
}
