/**
 * Window helpers for `select` (spec §10, §13 tool 12).
 *
 * The brand is a symbol. JSON cannot create one, so a request cannot add a
 * window. A plain object in `select` stays OKM1120. The SQL loads on the first
 * `find` or `one` whose `select` contains one.
 */

declare const brand: unique symbol;

/**
 * Shared through the global symbol registry.
 *
 * The read planner tests this symbol and does not need this module on a plain
 * `select`. JSON cannot create it.
 */
const RUNTIME = Symbol.for("okmodel.window");

/** `asc` is nulls last and `desc` is nulls first unless `nulls` is set. */
type SortDir = "asc" | "desc" | { readonly dir: "asc" | "desc"; readonly nulls?: "first" | "last" };

/** Columns the window orders by. Names are checked when the call runs. */
export type WindowOrder = { readonly [field: string]: SortDir | undefined };

/** What a window helper stores. The planner reads this. */
export type WindowCall = {
  readonly label: "rowNumber" | "rank" | "denseRank" | "runningTotal";
  readonly fn: "row_number" | "rank" | "dense_rank" | "sum";
  readonly column: string | undefined;
  readonly partitionBy: readonly string[] | undefined;
  readonly orderBy: unknown;
  readonly as: string;
};

/**
 * A window helper.
 *
 * `A` is the result key. `V` is `number` for a rank, or the source column for
 * a running total.
 */
export type Window<A extends string, V extends string | number> = {
  readonly [brand]: V;
  readonly as: A;
};

/**
 * Options every window helper takes.
 *
 * `partitionBy` is the group. Omit it to number the whole result. `orderBy`
 * is the order inside that group. The primary key breaks ties. `as` is the
 * result key.
 */
type WindowOptions<A extends string> = {
  readonly partitionBy?: readonly string[];
  readonly orderBy: WindowOrder;
  readonly as: A;
};

/**
 * Reports whether `value` is a window helper.
 *
 * @param value - One `select` entry
 * @returns `true` when a helper in this module created it
 */
export function isWindow(value: unknown): value is WindowCall {
  return typeof value === "object" && value !== null && RUNTIME in value;
}

/**
 * Row number inside a group, starting at 1.
 *
 * Ties get distinct numbers. The primary key breaks them.
 *
 * @typeParam A - Result key
 * @param options - Group, order, and result key
 * @returns A tagged window. Pass it in `select` on `find` or `one`
 */
export function rowNumber<const A extends string>(options: WindowOptions<A>): Window<A, number> {
  return frame<A, number>("rowNumber", "row_number", undefined, options);
}

/**
 * Rank inside a group, with gaps after a tie.
 *
 * Two rows with the same order share a rank. The next rank skips. The primary
 * key breaks the order when you need a stable row, and it does not split the
 * rank.
 *
 * @typeParam A - Result key
 * @param options - Group, order, and result key
 * @returns A tagged window. Pass it in `select` on `find` or `one`
 */
export function rank<const A extends string>(options: WindowOptions<A>): Window<A, number> {
  return frame<A, number>("rank", "rank", undefined, options);
}

/**
 * Rank inside a group, without gaps after a tie.
 *
 * Two rows with the same order share a rank. The next rank is the next number.
 *
 * @typeParam A - Result key
 * @param options - Group, order, and result key
 * @returns A tagged window. Pass it in `select` on `find` or `one`
 */
export function denseRank<const A extends string>(options: WindowOptions<A>): Window<A, number> {
  return frame<A, number>("denseRank", "dense_rank", undefined, options);
}

/**
 * Running total of a number column.
 *
 * The total follows `orderBy` inside the group. A null number does not add.
 * The result uses the column's value type: a number, or the exact decimal
 * string of a `numeric` column.
 *
 * @typeParam C - Column
 * @typeParam A - Result key
 * @param column - Field to total
 * @param options - Group, order, and result key
 * @returns A tagged window. Pass it in `select` on `find` or `one`
 */
export function runningTotal<const C extends string, const A extends string>(
  column: C,
  options: WindowOptions<A>,
): Window<A, C> {
  return frame<A, C>("runningTotal", "sum", column, options);
}

function frame<const A extends string, V extends string | number>(
  label: WindowCall["label"],
  fn: WindowCall["fn"],
  column: string | undefined,
  options: WindowOptions<A>,
): Window<A, V> {
  const spec = options ?? { orderBy: undefined, as: undefined, partitionBy: undefined };
  return {
    [RUNTIME]: true,
    label,
    fn,
    column,
    partitionBy: spec.partitionBy,
    orderBy: spec.orderBy,
    as: spec.as,
  } as unknown as Window<A, V>;
}
