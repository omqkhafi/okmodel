/**
 * Time bucket for `aggregate` `groupBy` (spec §10, §13 tool 4).
 *
 * The brand is a symbol. JSON cannot create one, so a request cannot add a
 * bucket. A plain object in `groupBy` stays OKM1120. The SQL loads with the
 * first `aggregate()` whose `groupBy` contains a bucket.
 */

declare const brand: unique symbol;

/**
 * Shared through the global symbol registry.
 *
 * The aggregate chunk only tests for this symbol. Importing this module there
 * would lengthen minified names on the connect graphs. JSON cannot create it.
 */
const RUNTIME = Symbol.for("okmodel.bucket");

/** Calendar and clock units `bucket` accepts. */
export type BucketUnit =
  | "second"
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "quarter"
  | "year";

/** Week that starts on Monday (ISO), Sunday, or Saturday. */
export type WeekStart = "monday" | "sunday" | "saturday";

/**
 * A `bucket()` call.
 *
 * `C` is the column, `U` the unit, and `A` the result key.
 */
export type Bucket<C extends string, U extends string, A extends string> = {
  readonly [brand]: C;
  readonly unit: U;
  readonly as: A;
};

/** What {@link bucket} stores. The aggregate chunk reads this. */
export type BucketInput = {
  readonly column: unknown;
  readonly unit: unknown;
  readonly as: unknown;
  readonly tz: unknown;
  readonly weekStart: unknown;
};

/**
 * Groups a timestamp or date column by a calendar or clock unit.
 *
 * `tz` is required for `timestamptz` and refused for `date`. `timestamp`
 * without a zone is refused. `as` is the result key. `__proto__`, `constructor`,
 * `toString`, and `hasOwnProperty` are refused when the aggregate runs.
 * `weekStart` applies only
 * to `week` and defaults to Monday. A NULL timestamp is its own group: the
 * `as` key is present and the value is null.
 *
 * Day, week, month, quarter, and year come back as `Temporal.PlainDate` (the
 * local date the period starts). Second, minute, and hour come back as
 * `Temporal.Instant` (the period start).
 *
 * @typeParam C - Column name
 * @typeParam U - Unit
 * @typeParam A - Result key
 * @param column - Field to bucket
 * @param unit - Period
 * @param options - Zone, result key, and week start
 * @returns A tagged bucket. Pass it in `groupBy`
 */
export function bucket<const C extends string, const U extends BucketUnit, const A extends string>(
  column: C,
  unit: U,
  options: {
    readonly tz?: string;
    readonly as: A;
    readonly weekStart?: WeekStart;
  },
): Bucket<C, U, A> {
  const spec = options ?? { as: undefined, tz: undefined, weekStart: undefined };
  return {
    [RUNTIME]: true,
    column,
    unit,
    as: spec.as,
    tz: spec.tz,
    weekStart: spec.weekStart,
  } as unknown as Bucket<C, U, A>;
}

/**
 * Reports whether `value` is a {@link bucket} call.
 *
 * @param value - One `groupBy` entry
 * @returns `true` when {@link bucket} created it
 */
export function isBucket(value: unknown): value is BucketInput {
  return typeof value === "object" && value !== null && RUNTIME in value;
}
