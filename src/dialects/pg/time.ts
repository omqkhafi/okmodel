/**
 * Date and time columns.
 *
 * A column is ISO text, a JS `Date`, or a Temporal value (D321). The mode is
 * a client choice: it never reaches the catalog, its hash, or the SQL. ISO and
 * `Date` codecs live here. Temporal codecs load from `temporal.ts` when a
 * client connects, so a graph with no `temporal` column does not carry them.
 */

import { type ColumnBuilder, type PlainFlags, required } from "./column.js";
import { definition, rejected } from "./misuse.js";
import { decodeText } from "./text.js";
import type { TimeWithOffset } from "./temporal.js";

/** How a date or time value is represented in TypeScript. */
export type TimeMode = "iso" | "date" | "temporal";

/** Postgres date and time types. */
export type TimeKind = "timestamptz" | "timestamp" | "date" | "time" | "timetz" | "interval";

/** Fractional seconds accepted by the date/time builders. */
export type TimePrecision = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Options object for a date or time builder.
 *
 * `mode` wins over `schema({ defaults: { time } })`. `precision` is the same
 * number the positional form takes.
 */
export type TimeOptions = {
  readonly mode?: TimeMode;
  readonly precision?: number;
};

/** Options object for `interval()`. `fields` is the same qualifier the positional form takes. */
export type IntervalOptions = {
  readonly mode?: TimeMode;
  readonly fields?: string;
};

/**
 * Text of a column that follows `schema({ defaults: { time } })`.
 *
 * It is a string. `schema()` swaps it for a `Date` or a Temporal value when
 * the default is `"date"` or `"temporal"`. The column type rides on a
 * `charAt` overload every string already has, so a plain string is a
 * `TimeText` and a subtype of it.
 */
export type TimeText<K extends TimeKind> = string & { charAt(pos: number, kind?: K): string };

/** The column type a {@link TimeText} carries, or `never` for any other value. */
type KindOf<V> = V extends { charAt(pos: number, kind?: infer K): string }
  ? unknown extends K
    ? never
    : K
  : never;

type TemporalTypes = {
  readonly timestamptz: Temporal.Instant;
  readonly timestamp: Temporal.PlainDateTime;
  readonly date: Temporal.PlainDate;
  readonly time: Temporal.PlainTime;
  readonly timetz: TimeWithOffset;
  readonly interval: Temporal.Duration;
};

/**
 * Value of a `K` column in mode `M`. No mode is {@link TimeText}.
 *
 * `date` is a `Date` only for `date`, `timestamp`, and `timestamptz`.
 */
export type TimeValue<K extends TimeKind, M> = M extends "temporal"
  ? TemporalTypes[K]
  : M extends "date"
    ? K extends "timestamptz" | "timestamp" | "date"
      ? Date
      : string
    : M extends "iso"
      ? string
      : TimeText<K>;

/**
 * Replaces {@link TimeText} in a field value with the value of mode `M`.
 *
 * A plain `string` stays. Arrays are walked.
 */
export type Retime<V, M extends TimeMode> = V extends string
  ? [KindOf<V>] extends [never]
    ? V
    : TimeValue<Extract<KindOf<V>, TimeKind>, M>
  : V extends readonly unknown[]
    ? { readonly [I in keyof V]: Retime<V[I], M> }
    : V;

/** `true` when `V` is {@link TimeText}, so `sum` and `avg` can leave it out. */
export type IsTimeText<V> = [KindOf<NonNullable<V>>] extends [never] ? false : true;

/** `O` with `mode` set to `M`. */
type Moded<O, M extends TimeMode> = O & { readonly mode: M };

/** Options object for `date()`. */
export type DateOptions = { readonly mode?: TimeMode };

/** Codec of one mode. */
export type TimeCodec = {
  readonly encode: (value: never) => string;
  readonly decode: (wire: string) => unknown;
  readonly accepts?: readonly string[];
};

/**
 * Time facts a column carries beside its codec. Not part of the catalog.
 *
 * `mode` is `undefined` while the column follows the schema default.
 * `codec` builds the codec for another mode.
 */
export type TimeSpec = {
  readonly mode: TimeMode | undefined;
  readonly codec: (mode: TimeMode) => TimeCodec;
};

/**
 * Timestamp with time zone. ISO text is `2026-11-03T09:00:53.582634Z`.
 *
 * @param options - Fractional seconds 0 through 6, or `{ mode, precision }`
 * @returns A timestamptz column
 */
export function timestamptz(precision?: number): ColumnBuilder<TimeText<"timestamptz">, PlainFlags>;
export function timestamptz(options: Moded<TimeOptions, "iso">): ColumnBuilder<string, PlainFlags>;
export function timestamptz(options: Moded<TimeOptions, "date">): ColumnBuilder<Date, PlainFlags>;
export function timestamptz(
  options: Moded<TimeOptions, "temporal">,
): ColumnBuilder<Temporal.Instant, PlainFlags>;
export function timestamptz(
  options: TimeOptions,
): ColumnBuilder<TimeText<"timestamptz">, PlainFlags>;
export function timestamptz<TValue>(
  options?: number | TimeOptions,
): ColumnBuilder<TValue, PlainFlags> {
  return timed(
    "timestamptz",
    options,
    /^(-?infinity|\d{4,}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d{1,6})?)?(Z|[+-]\d\d(:?\d\d)?))$/,
    "2026-11-03T09:00:53.582634Z",
    "Temporal.Instant",
  );
}

/**
 * Timestamp without time zone. ISO text is `2026-11-03T09:00:53.582634`.
 * A `Date` is read and written as UTC.
 *
 * @param options - Fractional seconds 0 through 6, or `{ mode, precision }`
 * @returns A timestamp column
 */
export function timestamp(precision?: number): ColumnBuilder<TimeText<"timestamp">, PlainFlags>;
export function timestamp(options: Moded<TimeOptions, "iso">): ColumnBuilder<string, PlainFlags>;
export function timestamp(options: Moded<TimeOptions, "date">): ColumnBuilder<Date, PlainFlags>;
export function timestamp(
  options: Moded<TimeOptions, "temporal">,
): ColumnBuilder<Temporal.PlainDateTime, PlainFlags>;
export function timestamp(options: TimeOptions): ColumnBuilder<TimeText<"timestamp">, PlainFlags>;
export function timestamp<TValue>(
  options?: number | TimeOptions,
): ColumnBuilder<TValue, PlainFlags> {
  return timed(
    "timestamp",
    options,
    /^(-?infinity|\d{4,}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d{1,6})?)?)$/,
    "2026-11-03T09:00:53",
    "Temporal.PlainDateTime",
  );
}

/**
 * Calendar date, `YYYY-MM-DD`. A `Date` is midnight UTC.
 *
 * @param options - `{ mode }`
 * @returns A date column
 */
export function date(): ColumnBuilder<TimeText<"date">, PlainFlags>;
export function date(options: Moded<DateOptions, "iso">): ColumnBuilder<string, PlainFlags>;
export function date(options: Moded<DateOptions, "date">): ColumnBuilder<Date, PlainFlags>;
export function date(
  options: Moded<DateOptions, "temporal">,
): ColumnBuilder<Temporal.PlainDate, PlainFlags>;
export function date(options: DateOptions): ColumnBuilder<TimeText<"date">, PlainFlags>;
export function date<TValue>(options?: DateOptions): ColumnBuilder<TValue, PlainFlags> {
  return timed(
    "date",
    options,
    /^(-?infinity|\d{4,}-\d\d-\d\d)$/,
    "2026-11-03",
    "Temporal.PlainDate",
  );
}

/**
 * Time of day. ISO text is `09:00:53.582634`. `"date"` mode keeps the text.
 *
 * @param options - Fractional seconds 0 through 6, or `{ mode, precision }`
 * @returns A time column
 */
export function time(precision?: number): ColumnBuilder<TimeText<"time">, PlainFlags>;
export function time(options: Moded<TimeOptions, "iso">): ColumnBuilder<string, PlainFlags>;
export function time(options: Moded<TimeOptions, "date">): ColumnBuilder<string, PlainFlags>;
export function time(
  options: Moded<TimeOptions, "temporal">,
): ColumnBuilder<Temporal.PlainTime, PlainFlags>;
export function time(options: TimeOptions): ColumnBuilder<TimeText<"time">, PlainFlags>;
export function time<TValue>(options?: number | TimeOptions): ColumnBuilder<TValue, PlainFlags> {
  return timed(
    "time",
    options,
    /^\d\d:\d\d(:\d\d(\.\d{1,6})?)?$/,
    "09:00:53",
    "Temporal.PlainTime",
  );
}

/**
 * Time of day with a numeric offset. `"iso"` and `"date"` keep the text
 * Postgres sends, such as `09:00:53.5+05:30`.
 *
 * @param options - Fractional seconds 0 through 6, or `{ mode, precision }`
 * @returns A timetz column
 */
export function timetz(precision?: number): ColumnBuilder<TimeText<"timetz">, PlainFlags>;
export function timetz(options: Moded<TimeOptions, "iso">): ColumnBuilder<string, PlainFlags>;
export function timetz(options: Moded<TimeOptions, "date">): ColumnBuilder<string, PlainFlags>;
export function timetz(
  options: Moded<TimeOptions, "temporal">,
): ColumnBuilder<TimeWithOffset, PlainFlags>;
export function timetz(options: TimeOptions): ColumnBuilder<TimeText<"timetz">, PlainFlags>;
export function timetz<TValue>(options?: number | TimeOptions): ColumnBuilder<TValue, PlainFlags> {
  return timed(
    "timetz",
    options,
    /^\d\d:\d\d(:\d\d(\.\d{1,6})?)?[+-]\d\d(:?\d\d)?$/,
    "09:00:53+00",
    "Object",
  );
}

/**
 * Interval. `fields` selects a Postgres qualifier such as `day to second`.
 * `"iso"` and `"date"` keep the text Postgres sends, such as `1 day 02:00:00`.
 *
 * @param options - Field qualifier, or `{ mode, fields }`
 * @returns An interval column
 */
export function interval(fields?: string): ColumnBuilder<TimeText<"interval">, PlainFlags>;
export function interval(options: Moded<IntervalOptions, "iso">): ColumnBuilder<string, PlainFlags>;
export function interval(
  options: Moded<IntervalOptions, "date">,
): ColumnBuilder<string, PlainFlags>;
export function interval(
  options: Moded<IntervalOptions, "temporal">,
): ColumnBuilder<Temporal.Duration, PlainFlags>;
export function interval(options: IntervalOptions): ColumnBuilder<TimeText<"interval">, PlainFlags>;
export function interval<TValue>(
  options?: string | IntervalOptions,
): ColumnBuilder<TValue, PlainFlags> {
  const open: IntervalOptions | undefined =
    typeof options === "string" ? { fields: options } : options;
  return timed(
    "interval",
    open?.mode === undefined ? undefined : { mode: open.mode },
    /\S/,
    "1 day 02:00:00",
    "Temporal.Duration",
    open?.fields === undefined ? undefined : intervalFields(open.fields),
  );
}

/**
 * Loads the date and time codecs a client decodes with, and the Temporal
 * ones. A client calls it before its first query. Call it yourself to decode,
 * or to encode a `date` or `temporal` value, without a client. Safe to call
 * more than once.
 *
 * @returns Settles when the codecs are ready
 */
export function loadTimeCodecs(): Promise<void> {
  loading ??= import("./time-codec.js").then((mod) => {
    loaded = mod;
  });
  return loading;
}

/**
 * Whether the runtime has a Temporal global.
 *
 * @returns `true` when `globalThis.Temporal` is an object
 */
export function hasTemporal(): boolean {
  const value: unknown = (globalThis as { readonly Temporal?: unknown }).Temporal;
  return typeof value === "object" && value !== null;
}

/**
 * Refuses a missing Temporal global (OKM1210). Names the runtime when it can.
 */
export function temporalMissing(): never {
  const host = globalThis as {
    readonly Bun?: { readonly version: string };
    readonly process?: { readonly versions?: { readonly node?: string } };
    readonly navigator?: { readonly userAgent?: string };
  };
  const node = host.process?.versions?.node;
  rejected(
    `${host.Bun ? `Bun ${host.Bun.version}` : host.navigator?.userAgent === "Cloudflare-Workers" ? "Cloudflare Workers" : node ? `Node ${node}` : "This runtime"} has no Temporal global for a temporal column. Native Temporal is in Node 26+ and Bun 1.4+. On Node 22, Node 24, or Workers, assign a polyfill to globalThis.Temporal, or use schema({ defaults: { time: "iso" } }) or { mode: "iso" } on the column.`,
  );
}

/**
 * Checks a mode name (OKM1060).
 *
 * @param mode - Value given
 * @param role - Where it was given, such as `schema() defaults.time`
 * @returns The mode
 */
export function timeMode(mode: unknown, role: string): TimeMode {
  if (mode !== "iso" && mode !== "date" && mode !== "temporal") {
    definition(`${role} ${String(mode)} must be iso, date, or temporal.`);
  }
  return mode;
}

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

let loaded: typeof import("./time-codec.js") | undefined;
let loading: Promise<void> | undefined;

function timed<TValue>(
  kind: TimeKind,
  options: number | TimeOptions | undefined,
  iso: RegExp,
  example: string,
  tag: string,
  fields?: string,
): ColumnBuilder<TValue, PlainFlags> {
  const open: TimeOptions | undefined =
    typeof options === "number" ? { precision: options } : options;
  const mode = open?.mode === undefined ? undefined : timeMode(open.mode, `${kind} mode`);
  const digits = timePrecision(open?.precision, kind);
  // Postgres sends date, timetz, and interval text as their ISO form.
  const plain = kind === "date" || kind === "timetz" || kind === "interval";
  const make = (next: TimeMode): TimeCodec => {
    // time, timetz, and interval have no Date: `date` keeps the ISO text.
    const used = next === "date" && kind !== "date" && !kind.startsWith("timestamp") ? "iso" : next;
    return {
      encode:
        used === "iso"
          ? (value: unknown) => {
              if (typeof value !== "string" || !iso.test(value)) {
                rejected(`${kind} ${String(value)} must be ISO-8601 text, for example ${example}.`);
              }
              return value;
            }
          : (value: unknown) => codecs().encodeTime(kind, used, value, digits),
      decode:
        used === "iso" && plain ? decodeText : (wire) => codecs().decodeTime(kind, used, wire),
      ...(used === "iso" ? {} : { accepts: [used === "date" ? "Date" : tag] }),
    };
  };
  return required({
    baseType:
      fields !== undefined
        ? `${kind} ${fields}`
        : digits === undefined
          ? kind
          : `${kind}(${String(digits)})`,
    ...make(mode ?? "iso"),
    sqlForm: "quote",
    time: { mode, codec: make },
  } as never);
}

function codecs(): typeof import("./time-codec.js") {
  if (loaded !== undefined) return loaded;
  rejected("Time codecs load on connect. Await client.connected or loadTimeCodecs() first.");
}
