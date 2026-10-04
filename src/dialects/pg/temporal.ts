/**
 * Temporal codecs. `Temporal` is read when a value is encoded or decoded.
 */

import { definition, rejected } from "./misuse.js";

/** What to install when the runtime has no Temporal global. */
const TEMPORAL_MISSING =
  "Date and time codecs need the Temporal global. okmodel does not ship a polyfill. Use a runtime that provides Temporal, or assign a polyfill to globalThis.Temporal before using these columns.";

/**
 * Reads `globalThis.Temporal`.
 *
 * The codecs do not bundle a polyfill. Node and Bun provide the global;
 * another runtime must assign one before encode or decode.
 */
function requireTemporal(): void {
  const temporal: unknown = globalThis.Temporal;
  if (typeof temporal !== "object" || temporal === null || !("Instant" in temporal)) {
    rejected(TEMPORAL_MISSING);
  }
}

/** A time of day with a numeric UTC offset. Temporal has no timetz value. */
export type TimeWithOffset = {
  readonly time: Temporal.PlainTime;
  readonly offset: string;
};

/** Fractional seconds accepted by the date/time builders. */
export type TimePrecision = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Checks a fractional-second precision.
 *
 * @param precision - Digits, or omitted
 * @param role - Column type name
 * @returns The precision, or undefined when omitted
 */
export function timePrecision(
  precision: number | undefined,
  role: string,
): TimePrecision | undefined {
  if (precision === undefined) {
    return undefined;
  }
  if (!Number.isInteger(precision) || precision < 0 || precision > 6) {
    definition(`${role} precision ${String(precision)} must be an integer from 0 to 6.`);
  }
  return precision as TimePrecision;
}

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
    return value.toString();
  }
  return value.toString({ fractionalSecondDigits: precision });
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
    return value.toString();
  }
  return value.toString({ fractionalSecondDigits: precision });
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
  return value.toString();
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
    return value.toString();
  }
  return value.toString({ fractionalSecondDigits: precision });
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
  const text = value.toString();
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
    return Temporal.Duration.from(rest.trim() === "" && wire !== "" ? fields : wire);
  } catch {
    rejected(
      `interval ${wire} must be what Postgres sends (for example 01:30:00 or 1 day 02:03:04) or an ISO-8601 duration (PT1H). Parts of different signs are not one Temporal.Duration.`,
    );
  }
}

/**
 * Postgres interval field qualifier.
 *
 * @param fields - Qualifier such as `day to second`
 * @returns The same qualifier when it is known
 */
export function intervalFields(fields: string): string {
  switch (fields) {
    case "year":
    case "month":
    case "day":
    case "hour":
    case "minute":
    case "second":
    case "year to month":
    case "day to hour":
    case "day to minute":
    case "day to second":
    case "hour to minute":
    case "hour to second":
    case "minute to second":
      return fields;
    default:
      definition(
        `interval fields ${fields} must be one of: year, month, day, hour, minute, second, year to month, day to hour, day to minute, day to second, hour to minute, hour to second, minute to second.`,
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
 * Temporal is in the runtime (Node and Bun) and not in this repository's
 * TypeScript libs. These declarations name the methods the codecs call.
 */
declare global {
  /** Instant, plain date-time, date, time, and duration. */
  namespace Temporal {
    /** UTC instant. */
    interface Instant {
      /**
       * @param options - Fractional digits to keep
       * @returns ISO-8601 text
       */
      toString(options?: { readonly fractionalSecondDigits?: number }): string;
    }
    /** Date and time without a zone. */
    interface PlainDateTime {
      /**
       * @param options - Fractional digits to keep
       * @returns ISO-8601 text
       */
      toString(options?: { readonly fractionalSecondDigits?: number }): string;
    }
    /** Calendar date. */
    interface PlainDate {
      /**
       * @returns `YYYY-MM-DD`
       */
      toString(): string;
      /**
       * @param duration - Days to add
       * @returns A later or earlier date
       */
      add(duration: { readonly days: number }): Temporal.PlainDate;
    }
    /** Time of day. */
    interface PlainTime {
      /**
       * @param options - Fractional digits to keep
       * @returns Time text
       */
      toString(options?: { readonly fractionalSecondDigits?: number }): string;
    }
    /** ISO-8601 duration. */
    interface Duration {
      /**
       * @returns ISO-8601 duration text
       */
      toString(): string;
    }
  }

  /** Temporal constructors used by the codecs. */
  var Temporal: {
    readonly Instant: {
      /**
       * @param item - ISO-8601 instant
       * @returns An instant
       */
      from(item: string): Temporal.Instant;
    };
    readonly PlainDateTime: {
      /**
       * @param item - ISO-8601 date-time
       * @returns A plain date-time
       */
      from(item: string): Temporal.PlainDateTime;
    };
    readonly PlainDate: {
      /**
       * @param item - `YYYY-MM-DD`
       * @returns A date
       */
      from(item: string): Temporal.PlainDate;
    };
    readonly PlainTime: {
      /**
       * @param item - Time text
       * @returns A time
       */
      from(item: string): Temporal.PlainTime;
    };
    readonly Duration: {
      /**
       * @param item - ISO-8601 duration, or numeric fields
       * @returns A duration
       */
      from(item: string | Readonly<Record<string, number>>): Temporal.Duration;
    };
  };
}
