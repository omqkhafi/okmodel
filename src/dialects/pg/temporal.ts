/**
 * Temporal codecs. `Temporal` is read when a value is encoded or decoded.
 *
 * `time.ts` loads this module when a client connects and a column is in
 * `temporal` mode. `tstzrange` and `daterange` import it directly.
 */

import { rejected } from "./misuse.js";
import { hasTemporal, temporalMissing, type TimeKind, type TimePrecision } from "./time.js";

type ClockText = {
  toString(options?: { readonly fractionalSecondDigits?: number }): string;
};

/** Refuses a missing Temporal global. okmodel does not ship a polyfill. */
function requireTemporal(): void {
  if (!hasTemporal()) temporalMissing();
}

/** `Object.prototype.toString` tag of each kind's Temporal value. */
const TAGS: Readonly<Record<TimeKind, string>> = {
  timestamptz: "Temporal.Instant",
  timestamp: "Temporal.PlainDateTime",
  date: "Temporal.PlainDate",
  time: "Temporal.PlainTime",
  timetz: "Object",
  interval: "Temporal.Duration",
};

/**
 * Encodes a Temporal value of one kind.
 *
 * A value of another type is refused, not converted with `toString()`.
 *
 * @param kind - Column type
 * @param value - Application value
 * @param digits - Fractional digits, or full precision when omitted
 * @returns Wire text
 */
export function encodeTemporal(
  kind: TimeKind,
  value: unknown,
  digits: TimePrecision | undefined,
): string {
  requireTemporal();
  const tag = TAGS[kind];
  if ({}.toString.call(value) !== `[object ${tag}]`) {
    rejected(
      `${kind} ${String(value)} must be ${kind === "timetz" ? "{ time: Temporal.PlainTime, offset }" : `a ${tag}`}.`,
    );
  }
  switch (kind) {
    case "timestamptz":
      return encodeInstant(value as Temporal.Instant, digits);
    case "timestamp":
      return encodeDateTime(value as Temporal.PlainDateTime, digits);
    case "date":
      return encodeDate(value as Temporal.PlainDate);
    case "time":
      return encodeTime(value as Temporal.PlainTime, digits);
    case "timetz":
      return encodeTimeZone(value as TimeWithOffset, digits);
    default:
      return encodeDuration(value as Temporal.Duration);
  }
}

/**
 * Decodes wire text to the Temporal value of one kind.
 *
 * @param kind - Column type
 * @param wire - Wire text
 * @returns Temporal value
 */
export function decodeTemporal(kind: TimeKind, wire: string): unknown {
  switch (kind) {
    case "timestamptz":
      return decodeInstant(wire);
    case "timestamp":
      return decodeDateTime(wire);
    case "date":
      return decodeDate(wire);
    case "time":
      return decodeTime(wire);
    case "timetz":
      return decodeTimeZone(wire);
    default:
      return decodeDuration(wire);
  }
}

/** A time of day with a numeric UTC offset. Temporal has no timetz value. */
export type TimeWithOffset = {
  readonly time: Temporal.PlainTime;
  readonly offset: string;
};

/**
 * Encodes an instant.
 *
 * @param value - Instant
 * @param precision - Fractional digits, or full precision when omitted
 * @returns ISO-8601 text
 */
export function encodeInstant(value: Temporal.Instant, precision?: TimePrecision): string {
  requireTemporal();
  if (precision === undefined) {
    return (value as ClockText).toString();
  }
  return (value as ClockText).toString({ fractionalSecondDigits: precision });
}

/**
 * Decodes an instant.
 *
 * @param wire - ISO-8601 text
 * @returns An instant
 */
export function decodeInstant(wire: string): Temporal.Instant {
  requireTemporal();
  try {
    // Temporal is a runtime global. TypeScript 7 has no Temporal lib, and the shipped declaration stays empty so it can merge.
    // @ts-ignore TS2708
    return Temporal.Instant.from(wire);
  } catch {
    rejected(`timestamptz ${wire} must be an ISO-8601 instant, for example 2020-01-01T00:00:00Z.`);
  }
}

/**
 * Encodes a timestamp without time zone.
 *
 * @param value - Local date and time
 * @param precision - Fractional digits
 * @returns ISO-8601 text without a zone
 */
export function encodeDateTime(value: Temporal.PlainDateTime, precision?: TimePrecision): string {
  requireTemporal();
  if (precision === undefined) {
    return (value as ClockText).toString();
  }
  return (value as ClockText).toString({ fractionalSecondDigits: precision });
}

/**
 * Decodes a timestamp without time zone.
 *
 * @param wire - ISO-8601 text
 * @returns A plain date-time
 */
export function decodeDateTime(wire: string): Temporal.PlainDateTime {
  requireTemporal();
  try {
    // @ts-ignore TS2708
    return Temporal.PlainDateTime.from(wire);
  } catch {
    rejected(
      `timestamp ${wire} must be an ISO-8601 date-time without a zone, for example 2020-01-01T00:00:00.`,
    );
  }
}

/**
 * Encodes a date.
 *
 * @param value - Date
 * @returns `YYYY-MM-DD`
 */
export function encodeDate(value: Temporal.PlainDate): string {
  requireTemporal();
  return (value as ClockText).toString();
}

/**
 * Decodes a date.
 *
 * @param wire - `YYYY-MM-DD`
 * @returns A date
 */
export function decodeDate(wire: string): Temporal.PlainDate {
  requireTemporal();
  try {
    // @ts-ignore TS2708
    return Temporal.PlainDate.from(wire);
  } catch {
    rejected(`date ${wire} must be YYYY-MM-DD.`);
  }
}

/**
 * Encodes a time of day.
 *
 * @param value - Time
 * @param precision - Fractional digits
 * @returns `HH:MM:SS` text
 */
export function encodeTime(value: Temporal.PlainTime, precision?: TimePrecision): string {
  requireTemporal();
  if (precision === undefined) {
    return (value as ClockText).toString();
  }
  return (value as ClockText).toString({ fractionalSecondDigits: precision });
}

/**
 * Decodes a time of day.
 *
 * @param wire - Time text
 * @returns A time
 */
export function decodeTime(wire: string): Temporal.PlainTime {
  requireTemporal();
  try {
    // @ts-ignore TS2708
    return Temporal.PlainTime.from(wire);
  } catch {
    rejected(`time ${wire} must be a time of day, for example 00:00:00.`);
  }
}

/**
 * Encodes a time with offset.
 *
 * @param value - Time and offset
 * @param precision - Fractional digits
 * @returns Time text plus `±HH:MM`
 */
export function encodeTimeZone(value: TimeWithOffset, precision?: TimePrecision): string {
  requireTemporal();
  if (!offsetText().test(value.offset)) {
    rejected(`timetz offset ${value.offset} must be ±HH:MM.`);
  }
  return `${encodeTime(value.time, precision)}${value.offset}`;
}

/**
 * Decodes a time with offset.
 *
 * @param wire - Time text plus an offset, `±HH` as Postgres sends it or `±HH:MM`
 * @returns Time and offset, the offset as `±HH:MM`
 */
export function decodeTimeZone(wire: string): TimeWithOffset {
  const match = timeZoneText().exec(wire);
  const time = match?.[1];
  const hours = match?.[2];
  if (time === undefined || hours === undefined) {
    rejected(`timetz ${wire} must be a time of day plus ±HH or ±HH:MM, for example 00:00:00+00.`);
  }
  return { time: decodeTime(time), offset: `${hours}:${match?.[3] ?? "00"}` };
}

/**
 * Encodes a duration as an ISO-8601 duration.
 *
 * @param value - Duration
 * @returns ISO-8601 text Postgres accepts for interval, with a sign on each field when negative
 */
export function encodeDuration(value: Temporal.Duration): string {
  requireTemporal();
  const text = (value as ClockText).toString();
  // Postgres refuses a leading minus and takes a sign on each field
  return text.startsWith("-") ? text.slice(1).replace(/\d+(?:\.\d+)?(?=[A-Z])/g, "-$&") : text;
}

/**
 * Decodes an interval as Postgres sends it: `1 year 2 mons 3 days 04:05:06.5`,
 * `01:30:00`, or an ISO-8601 duration. A part may carry a sign. Parts of
 * different signs (`1 day -01:00:00`) cannot be one `Temporal.Duration`.
 *
 * @param wire - Interval text
 * @returns A duration
 */
export function decodeDuration(wire: string): Temporal.Duration {
  requireTemporal();
  const fields: Record<string, number> = {};
  const rest = wire.replace(
    /([+-]?\d+) (year|mon|day)s?|([+-]?)(\d+):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/g,
    (_part, count?: string, unit?: string, sign?: string, h = "", m = "", s = "", f = "") => {
      if (count !== undefined && unit !== undefined) {
        fields[`${unit === "mon" ? "month" : unit}s`] = Number(count);
        return "";
      }
      const micros = Number(f.padEnd(6, "0"));
      const flip = sign === "-" ? -1 : 1;
      fields.hours = flip * Number(h);
      fields.minutes = flip * Number(m);
      fields.seconds = flip * Number(s);
      fields.milliseconds = flip * Math.trunc(micros / 1000);
      fields.microseconds = flip * (micros % 1000);
      return "";
    },
  );
  try {
    // @ts-ignore TS2708
    return Temporal.Duration.from(rest.trim() === "" && wire !== "" ? fields : wire);
  } catch {
    rejected(
      `interval ${wire} must be what Postgres sends (for example 01:30:00 or 1 day 02:03:04) or an ISO-8601 duration (PT1H). Parts of different signs are not one Temporal.Duration.`,
    );
  }
}

function offsetText(): RegExp {
  offsetPattern ??= /^[+-]\d{2}:\d{2}$/;
  return offsetPattern;
}

function timeZoneText(): RegExp {
  timeZonePattern ??= /^(.+?)([+-]\d{2})(?::(\d{2}))?$/;
  return timeZonePattern;
}

let offsetPattern: RegExp | undefined;
let timeZonePattern: RegExp | undefined;

/**
 * Empty names so `Temporal.Instant` and the other codec types merge with
 * TypeScript's Temporal lib and with `temporal-polyfill`. Method signatures
 * live in `temporal.local.d.ts` for this repository's typecheck only. They
 * are not shipped: a second `toString` or `var Temporal` conflicts with those
 * libraries (QA-L2).
 */
declare global {
  /** Instant, plain date-time, date, time, and duration. */
  namespace Temporal {
    /** UTC instant. */
    interface Instant {}
    /** Date and time without a zone. */
    interface PlainDateTime {}
    /** Calendar date. */
    interface PlainDate {}
    /** Time of day. */
    interface PlainTime {}
    /** ISO-8601 duration. */
    interface Duration {}
  }
}
