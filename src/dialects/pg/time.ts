/**
 * Date and time columns. The timestamp codec is Temporal.
 */

import { type ColumnBuilder, type PlainFlags, required } from "./column.js";
import {
  type TimePrecision,
  type TimeWithOffset,
  decodeDate,
  decodeDateTime,
  decodeDuration,
  decodeInstant,
  decodeTime,
  decodeTimeZone,
  encodeDate,
  encodeDateTime,
  encodeDuration,
  encodeInstant,
  encodeTime,
  encodeTimeZone,
  intervalFields,
  timePrecision,
} from "./temporal.js";

/**
 * Timestamp with time zone.
 *
 * @param precision - Fractional seconds, 0 through 6
 * @returns A timestamptz column
 */
export function timestamptz(precision?: number): ColumnBuilder<Temporal.Instant, PlainFlags> {
  const digits = timePrecision(precision, "timestamptz");
  return required({
    baseType: timed("timestamptz", digits),
    encode: (value) => encodeInstant(value, digits),
    decode: decodeInstant,
    accepts: ["Temporal.Instant"],
    sqlForm: "quote",
  });
}

/**
 * Timestamp without time zone.
 *
 * @param precision - Fractional seconds, 0 through 6
 * @returns A timestamp column
 */
export function timestamp(precision?: number): ColumnBuilder<Temporal.PlainDateTime, PlainFlags> {
  const digits = timePrecision(precision, "timestamp");
  return required({
    baseType: timed("timestamp", digits),
    encode: (value) => encodeDateTime(value, digits),
    decode: decodeDateTime,
    accepts: ["Temporal.PlainDateTime"],
    sqlForm: "quote",
  });
}

/**
 * Calendar date.
 *
 * @returns A date column
 */
export function date(): ColumnBuilder<Temporal.PlainDate, PlainFlags> {
  return required({
    baseType: "date",
    encode: encodeDate,
    decode: decodeDate,
    accepts: ["Temporal.PlainDate"],
    sqlForm: "quote",
  });
}

/**
 * Time of day.
 *
 * @param precision - Fractional seconds, 0 through 6
 * @returns A time column
 */
export function time(precision?: number): ColumnBuilder<Temporal.PlainTime, PlainFlags> {
  const digits = timePrecision(precision, "time");
  return required({
    baseType: timed("time", digits),
    encode: (value) => encodeTime(value, digits),
    decode: decodeTime,
    accepts: ["Temporal.PlainTime"],
    sqlForm: "quote",
  });
}

/**
 * Time of day with a numeric offset.
 *
 * @param precision - Fractional seconds, 0 through 6
 * @returns A timetz column
 */
export function timetz(precision?: number): ColumnBuilder<TimeWithOffset, PlainFlags> {
  const digits = timePrecision(precision, "timetz");
  return required({
    baseType: timed("timetz", digits),
    encode: (value) => encodeTimeZone(value, digits),
    decode: decodeTimeZone,
    accepts: ["Object"],
    sqlForm: "quote",
  });
}

/**
 * Interval. `fields` selects a Postgres qualifier such as `day to second`.
 *
 * @param fields - Optional field qualifier
 * @returns An interval column
 */
export function interval(fields?: string): ColumnBuilder<Temporal.Duration, PlainFlags> {
  const qualifier = fields === undefined ? undefined : intervalFields(fields);
  return required({
    baseType: qualifier === undefined ? "interval" : `interval ${qualifier}`,
    encode: encodeDuration,
    decode: decodeDuration,
    accepts: ["Temporal.Duration"],
    sqlForm: "quote",
  });
}

function timed(name: string, precision: TimePrecision | undefined): string {
  if (precision === undefined) {
    return name;
  }
  return `${name}(${String(precision)})`;
}
