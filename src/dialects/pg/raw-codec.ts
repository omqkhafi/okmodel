/**
 * Codecs for typed `raw()` parameters and result columns.
 *
 * One lock `pgType` picks the codec the typed API already uses for that
 * Postgres type, and the one `okm raw sync` wrote the TypeScript type for
 * (`typescriptForPgType`). A type with no codec stays the driver's text. This
 * module is loaded with the first typed `raw()` call and by nothing else.
 */

import { boolean, bytea } from "./bool.js";
import type { ColumnBuilder, ColumnFlags } from "./column.js";
import { double, numeric, real } from "./decimal.js";
import { enumColumn } from "./enum.js";
import { line, point } from "./geometry.js";
import { bigint, integer, smallint } from "./integer.js";
import { json, jsonb } from "./json.js";
import { rejected } from "./misuse.js";
import { daterange, int4range, int8range, numrange, tstzrange } from "./range.js";
import { date, interval, time, timestamp, timestamptz, timetz } from "./time.js";
import { text } from "./text.js";

/** How the schema spells `bigint` and `numeric`. Both default to `string`. */
export type RawCodecModes = {
  readonly bigint?: "string" | "number" | "bigint";
  readonly numeric?: "string" | "number";
};

/** Encode for a parameter and decode for a column. */
export type RawCodec = {
  readonly encode: (value: unknown) => string;
  /** Absent when the wire text is the TypeScript value. */
  readonly decode: ((wire: string) => unknown) | undefined;
};

/**
 * Codec for one Postgres type.
 *
 * @param pgType - Lock type name, such as `integer`, `jsonb`, or `mood[]`
 * @param enumLabels - Labels when the type is an enum or an array of one
 * @param modes - Schema codec modes for `bigint` and `numeric`
 * @returns The codec. A type with no codec encodes strings and decodes nothing
 */
export function rawCodec(
  pgType: string,
  enumLabels: readonly string[] | undefined,
  modes: RawCodecModes | undefined,
): RawCodec {
  let base = pgType.trim();
  let dims = 0;
  while (base.endsWith("[]")) {
    dims += 1;
    base = base.slice(0, -2).trim();
  }
  const labels = enumLabels !== undefined && enumLabels.length > 0 ? enumLabels : undefined;
  const made: object | undefined =
    labels === undefined ? scalar(base, modes) : enumColumn("enum", labels);
  if (made === undefined && dims === 0) return { encode: textOnly, decode: undefined };
  let column = (made ?? text()) as Erased;
  if (dims > 0) column = column.array({ dims }) as Erased;
  const state = column.state;
  if (dims === 0 && state.baseType === "text") return { encode: textOnly, decode: undefined };
  return {
    encode: state.encode as (value: unknown) => string,
    decode: state.decode as (wire: string) => unknown,
  };
}

function textOnly(value: unknown): string {
  if (typeof value !== "string") {
    rejected(`A parameter with no codec takes a string. Received ${typeof value}.`);
  }
  return value;
}

type Erased = ColumnBuilder<unknown, ColumnFlags>;

function scalar(base: string, modes: RawCodecModes | undefined): object | undefined {
  switch (base) {
    case "smallint":
      return smallint();
    case "integer":
      return integer();
    case "real":
      return real();
    case "double precision":
      return double();
    case "bigint":
      return bigint({ as: modes?.bigint ?? "string" });
    case "numeric":
      return numeric(undefined, undefined, { as: modes?.numeric ?? "string" });
    case "text":
    case "varchar":
    case "char":
    case "citext":
    case "uuid":
    case "inet":
    case "cidr":
    case "macaddr":
    case "macaddr8":
    case "tsvector":
    case "ltree":
      return text();
    case "boolean":
      return boolean();
    case "bytea":
      return bytea();
    case "json":
      return json();
    case "jsonb":
      return jsonb();
    case "timestamptz":
      return timestamptz();
    case "timestamp":
      return timestamp();
    case "date":
      return date();
    case "time":
      return time();
    case "timetz":
      return timetz();
    case "interval":
      return interval();
    case "tstzrange":
      return tstzrange();
    case "daterange":
      return daterange();
    case "int4range":
      return int4range();
    case "int8range":
      return int8range();
    case "numrange":
      return numrange();
    case "point":
      return point();
    case "line":
      return line();
    default:
      return undefined;
  }
}
