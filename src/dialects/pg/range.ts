/**
 * Postgres range columns.
 *
 * A range is either empty or a pair of bounds. Unbounded sides use null.
 */

import { type ColumnBuilder, type PlainFlags, required } from "./column.js";
import { type RangeColumnMark, tagRange } from "./column-mark.js";
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
 * `[lower, upper)` shorthand. A null side is unbounded.
 *
 * @typeParam T - Bound type
 */
export type RangeTuple<T> = readonly [T | null, T | null];

/**
 * Timestamp with time zone range.
 *
 * @returns A tstzrange column
 */
export function tstzrange(): ColumnBuilder<Range<Temporal.Instant>, PlainFlags> {
  return rangeColumn(
    "tstzrange",
    "timestamptz",
    "tstzrange_subdiff",
    encodeInstant,
    decodeInstant,
    true,
  );
}

/**
 * Timestamp with time zone multirange.
 *
 * @returns A tstzmultirange column
 */
export function tstzmultirange(): ColumnBuilder<readonly Range<Temporal.Instant>[], PlainFlags> {
  return multirangeColumn(
    "tstzmultirange",
    "timestamptz",
    "tstzrange_subdiff",
    encodeInstant,
    decodeInstant,
    true,
  );
}

/**
 * Date range.
 *
 * @returns A daterange column
 */
export function daterange(): ColumnBuilder<Range<Temporal.PlainDate>, PlainFlags> {
  return rangeColumn("daterange", "date", "daterange_subdiff", encodeDate, decodeDate, true);
}

/**
 * Date multirange.
 *
 * @returns A datemultirange column
 */
export function datemultirange(): ColumnBuilder<readonly Range<Temporal.PlainDate>[], PlainFlags> {
  return multirangeColumn(
    "datemultirange",
    "date",
    "daterange_subdiff",
    encodeDate,
    decodeDate,
    true,
  );
}

/**
 * 32-bit integer range.
 *
 * @returns An int4range column
 */
export function int4range(): ColumnBuilder<Range<number>, PlainFlags> {
  return rangeColumn(
    "int4range",
    "integer",
    "int4range_subdiff",
    (value) => integerToken(value, -2_147_483_648, 2_147_483_647, "int4range"),
    (wire) => decodeBoundNumber(wire, "int4range"),
    false,
  );
}

/**
 * 32-bit integer multirange.
 *
 * @returns An int4multirange column
 */
export function int4multirange(): ColumnBuilder<readonly Range<number>[], PlainFlags> {
  return multirangeColumn(
    "int4multirange",
    "integer",
    "int4range_subdiff",
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
  return rangeColumn(
    "int8range",
    "bigint",
    "int8range_subdiff",
    encodeBigintString,
    decodeBigintString,
    false,
  );
}

/**
 * 64-bit integer multirange.
 *
 * @returns An int8multirange column
 */
export function int8multirange(): ColumnBuilder<readonly Range<string>[], PlainFlags> {
  return multirangeColumn(
    "int8multirange",
    "bigint",
    "int8range_subdiff",
    encodeBigintString,
    decodeBigintString,
    false,
  );
}

/**
 * Numeric range. Bounds are decimal strings.
 *
 * @returns A numrange column
 */
export function numrange(): ColumnBuilder<Range<string>, PlainFlags> {
  return rangeColumn(
    "numrange",
    "numeric",
    "numrange_subdiff",
    encodeNumericString,
    decodeNumericString,
    false,
  );
}

/**
 * Numeric multirange.
 *
 * @returns A nummultirange column
 */
export function nummultirange(): ColumnBuilder<readonly Range<string>[], PlainFlags> {
  return multirangeColumn(
    "nummultirange",
    "numeric",
    "numrange_subdiff",
    encodeNumericString,
    decodeNumericString,
    false,
  );
}

function rangeColumn<T>(
  baseType: string,
  subtype: string,
  subtypeDiff: string,
  encodeBound: (value: T) => string,
  decodeBound: (wire: string) => T,
  quote: boolean,
): ColumnBuilder<Range<T>, PlainFlags> {
  const mark = builtinMark(
    baseType,
    subtype,
    subtypeDiff,
    encodeBound,
    decodeBound,
    quote,
    "range",
  );
  const encode = tagRange(
    (value: unknown) => writeRange(value, encodeBound as (value: unknown) => string, quote),
    mark,
  );
  return required({
    baseType,
    encode,
    decode: (wire) => readRange(wire, decodeBound, quote),
    accepts: ["Object", "Array"],
    sqlForm: "cast",
  });
}

function multirangeColumn<T>(
  baseType: string,
  subtype: string,
  subtypeDiff: string,
  encodeBound: (value: T) => string,
  decodeBound: (wire: string) => T,
  quote: boolean,
): ColumnBuilder<readonly Range<T>[], PlainFlags> {
  const mark = builtinMark(
    baseType,
    subtype,
    subtypeDiff,
    encodeBound,
    decodeBound,
    quote,
    "multirange",
  );
  const encode = tagRange((value: unknown) => writeMulti(value, encodeBound, quote), mark);
  return required({
    baseType,
    encode,
    decode: (wire) => readMulti(wire, decodeBound, quote),
    accepts: ["Array"],
    sqlForm: "cast",
  });
}

function builtinMark<T>(
  baseType: string,
  subtype: string,
  subtypeDiff: string,
  encodeBound: (value: T) => string,
  decodeBound: (wire: string) => T,
  quote: boolean,
  kind: "range" | "multirange",
): RangeColumnMark {
  const bound = encodeBound as (value: unknown) => string;
  const mark: RangeColumnMark = {
    kind,
    type: baseType,
    subtype,
    subtypeDiff,
    multirange: kind === "multirange" ? baseType : `${baseType.replace(/range$/, "")}multirange`,
    quote,
    encodeBound: bound,
    asArray: (dims) => arrayCodec(baseType, bound, decodeBound, quote, dims),
    multi: () => {
      const multi = multirangeColumn(
        mark.multirange,
        subtype,
        subtypeDiff,
        encodeBound,
        decodeBound,
        quote,
      );
      return {
        baseType: mark.multirange,
        encode: multi.state.encode as (value: unknown) => string,
        decode: multi.state.decode as (wire: string) => unknown,
      };
    },
  };
  return mark;
}

function arrayCodec<T>(
  name: string,
  encodeBound: (value: unknown) => string,
  decodeBound: (wire: string) => T,
  quote: boolean,
  dims: number,
): { readonly encode: (value: unknown) => string; readonly decode: (wire: string) => unknown } {
  if (dims !== 1) rejected(`Range ${name} array dims ${String(dims)} must be 1.`);
  let encode: (value: unknown) => string;
  encode = tagRange(
    (value: unknown) => {
      if (!Array.isArray(value)) rejected(`Range ${name} array must be a list.`);
      return writeRangeArray(value, encodeBound, quote);
    },
    {
      kind: "range",
      type: name,
      subtype: name,
      multirange: name,
      quote,
      encodeBound,
      read: (sql) => `to_jsonb(${sql})::text`,
      asArray: () => arrayCodec(name, encodeBound, decodeBound, quote, 1),
      multi: () => ({
        baseType: name,
        encode,
        decode: (wire: string) => readRangeList(wire, decodeBound, quote),
      }),
    },
  );
  return {
    encode,
    decode: (wire) => readRangeList(wire, decodeBound, quote),
  };
}

/** Writes a range literal, a `[lower, upper)` tuple, or a multirange list. */
export function writeRange(
  value: unknown,
  encodeBound: (value: unknown) => string,
  quote: boolean,
): string {
  if (Array.isArray(value)) {
    if (value.length === 2 && !isRangeValue(value[0]) && !isRangeValue(value[1])) {
      return writeBounds(value[0], value[1], "[", ")", encodeBound, quote);
    }
    return writeMulti(value, encodeBound as (value: never) => string, quote);
  }
  if (!isRangeValue(value)) {
    rejected("range needs empty: true, or empty: false with lower and upper, or [lower, upper).");
  }
  if (value.empty) return "empty";
  return writeBounds(
    value.lower,
    value.upper,
    value.lowerInclusive ? "[" : "(",
    value.upperInclusive ? "]" : ")",
    encodeBound,
    quote,
  );
}

function writeBounds(
  lower: unknown,
  upper: unknown,
  open: "[" | "(",
  close: "]" | ")",
  encodeBound: (value: unknown) => string,
  quote: boolean,
): string {
  const left = lower === null || lower === undefined ? "" : boundText(encodeBound(lower), quote);
  const right = upper === null || upper === undefined ? "" : boundText(encodeBound(upper), quote);
  return `${open}${left},${right}${close}`;
}

function isRangeValue(value: unknown): value is Range<unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "empty" in value;
}

/** Writes a multirange literal. */
export function writeMulti<T>(
  value: unknown,
  encodeBound: (value: T) => string,
  quote: boolean,
): string {
  if (!Array.isArray(value)) rejected("multirange needs a list of ranges.");
  const parts = value.map((item) =>
    writeRange(item, encodeBound as (value: unknown) => string, quote),
  );
  return `{${parts.join(",")}}`;
}

/** Reads a multirange literal into a list of ranges. */
export function readMulti<T>(
  wire: string,
  decodeBound: (wire: string) => T,
  quote: boolean,
): readonly Range<T>[] {
  if (wire === "{}") return [];
  if (!wire.startsWith("{") || !wire.endsWith("}")) {
    rejected(`multirange ${wire} is not a multirange literal.`);
  }
  const body = wire.slice(1, -1);
  if (body.length === 0) return [];
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "[" || char === "(") depth += 1;
    if (char === "]" || char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((part) => readRange(part, decodeBound, quote));
}

/** Reads a JSON array from `to_jsonb` or a Postgres array literal. */
export function readRangeList<T>(
  wire: string,
  decodeBound: (wire: string) => T,
  quote: boolean,
): readonly Range<T>[] {
  const text = wire.trim();
  if (text.startsWith("[")) {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) rejected("range array must be a list.");
    return parsed.map((item) => {
      if (typeof item !== "string") rejected("range array element must be text.");
      return readRange(item, decodeBound, quote);
    });
  }
  if (text === "{}") return [];
  if (text.startsWith("{") && text.endsWith("}")) {
    return splitArray(text.slice(1, -1)).map((part) => readRange(part, decodeBound, quote));
  }
  rejected(`range array ${wire} is not a list.`);
}

function splitArray(body: string): string[] {
  if (body.length === 0) return [];
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '"' && body[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (char === "[" || char === "(") depth += 1;
    if (char === "]" || char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(unquoteArray(body.slice(start, index).trim()));
      start = index + 1;
    }
  }
  parts.push(unquoteArray(body.slice(start).trim()));
  return parts;
}

function unquoteArray(part: string): string {
  if (part.startsWith('"') && part.endsWith('"')) {
    return part.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  return part;
}

export function writeRangeArray(
  value: readonly unknown[],
  encodeBound: (value: unknown) => string,
  quote: boolean,
): string {
  const parts = value.map((item) => {
    const literal = writeRange(item, encodeBound, quote);
    return `"${literal.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  });
  return `{${parts.join(",")}}`;
}

function boundText(encoded: string, quote: boolean): string {
  if (!quote) {
    return encoded;
  }
  return `"${encoded.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Reads one range literal into the range object. */
export function readRange<T>(
  wire: string,
  decodeBound: (wire: string) => T,
  quote: boolean,
): Range<T> {
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
