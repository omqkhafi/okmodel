/**
 * Time buckets inside `aggregate` `groupBy` (spec §10, §13 tool 4).
 *
 * This module loads on the first `aggregate()` whose `groupBy` contains a
 * `bucket()`. A plain aggregate does not import it. A NULL timestamp is one
 * group: the `as` key is present and the value is null.
 */

import { throwNamed } from "../contracts/error.js";
import type { ColumnModel } from "../dialects/pg/model.js";
import { isBucket, type BucketUnit } from "../dialects/pg/ops/bucket.js";
import {
  fail,
  isRecord,
  list,
  parseOrder,
  projectExpr,
  quote,
  type Built,
  type Indexed,
  type Sink,
} from "./plan.js";
import { refusePrototypeKey } from "./result-name.js";

/** One bucket in a group list. */
export type BucketGroup = {
  readonly kind: "bucket";
  readonly column: ColumnModel;
  readonly unit: BucketUnit;
  readonly tz: string | undefined;
  readonly as: string;
  readonly shift: 0 | 1 | 2;
  readonly clock: boolean;
};

/**
 * What the aggregate chunk calls after this module loads.
 *
 * The aggregate chunk does not import this file. It receives the functions
 * from `import()`.
 */
export type BucketChunk = {
  readBucket(
    table: Indexed,
    value: unknown,
    fields: ReadonlySet<string>,
    aliases: Set<string>,
  ): BucketGroup;
  writeBucket(
    sink: Sink,
    outputs: Built | undefined,
    wrote: { at: number },
    group: BucketGroup,
  ): void;
  writeGrouped(sink: Sink, names: readonly string[], orderBy: unknown): void;
};

/**
 * Reads one `bucket()` group.
 *
 * Refuses a bad unit, zone, week start, or result name before any SQL.
 * `__proto__`, `constructor`, `toString`, and `hasOwnProperty` are refused.
 * `timestamptz` needs an IANA `tz`. `date` refuses `tz`. `timestamp` without
 * a zone is refused.
 *
 * @param table - The grouped table
 * @param value - One `groupBy` entry
 * @param fields - Plain group fields already seen
 * @param aliases - Bucket result names already seen
 * @returns The group the statement writes
 */
export function readBucket(
  table: Indexed,
  value: unknown,
  fields: ReadonlySet<string>,
  aliases: Set<string>,
): BucketGroup {
  if (!isBucket(value)) fail("OKM1120", "bucket group");
  const column = typeof value.column === "string" ? table.columns.get(value.column) : undefined;
  if (typeof value.column !== "string" || column === undefined) {
    throwNamed(
      "OKM1120",
      String(value.column),
      table.names,
      `Field ${String(value.column)} is not on ${table.model.name}. Accepted names: ${list(table.names)}.`,
    );
  }
  if (column.hidden) {
    fail("OKM1120", `Field ${column.field} is hidden, so groupBy cannot read it.`);
  }
  const unit = unitOf(value.unit);
  if (unit === undefined) {
    fail(
      "OKM1120",
      `bucket() unit ${String(value.unit)} is not a time unit. Accepted units: second, minute, hour, day, week, month, quarter, year.`,
    );
  }
  const shift = weekShift(value.weekStart, unit);
  const kind = temporalKind(column.dataType);
  if (kind !== "timestamptz" && kind !== "date") {
    fail(
      "OKM1120",
      `bucket() does not apply to ${kind === "timestamp" ? "timestamp" : column.dataType} column ${column.field}. Use timestamptz or date.`,
    );
  }
  if (kind === "date" && clockUnit(unit)) {
    fail(
      "OKM1120",
      `bucket() unit ${unit} does not apply to date column ${column.field}. Accepted units: day, week, month, quarter, year.`,
    );
  }
  let tz: string | undefined;
  if (kind === "timestamptz") {
    if (typeof value.tz !== "string") {
      fail(
        "OKM1120",
        `bucket() on timestamptz column ${column.field} needs tz, an IANA time zone.`,
      );
    }
    if (!iana(value.tz)) fail("OKM1120", `bucket() tz ${value.tz} is not an IANA time zone.`);
    tz = value.tz;
  } else if (value.tz !== undefined) {
    fail("OKM1120", `bucket() on date column ${column.field} does not take tz.`);
  }
  if (typeof value.as !== "string" || value.as.length === 0) {
    fail("OKM1120", "bucket() needs as, the name of the result key.");
  }
  refusePrototypeKey(value.as, "bucket as");
  if (
    value.as === "count" ||
    value.as === "sum" ||
    value.as === "avg" ||
    value.as === "min" ||
    value.as === "max"
  ) {
    fail("OKM1120", `bucket as ${value.as} clashes with an aggregate key.`);
  }
  if (fields.has(value.as) || aliases.has(value.as)) {
    fail("OKM1120", `bucket as ${value.as} clashes with another group.`);
  }
  aliases.add(value.as);
  return { kind: "bucket", column, unit, tz, as: value.as, shift, clock: clockUnit(unit) };
}

/**
 * Writes one bucket expression into the select list.
 *
 * @param sink - Statement buffer
 * @param outputs - Decode plan, absent while only marking
 * @param wrote - How many select items are already written
 * @param group - The bucket
 */
export function writeBucket(
  sink: Sink,
  outputs: Built | undefined,
  wrote: { at: number },
  group: BucketGroup,
): void {
  if (wrote.at > 0) sink.text(", ");
  if (group.clock) emitClock(sink, group);
  else emitCalendar(sink, group);
  outputs?.fields.push({
    key: `g:${group.as}`,
    at: wrote.at,
    decode: bucketDecode(group),
  });
  wrote.at += 1;
}

/**
 * Groups and orders by select-list ordinals.
 *
 * The bucket expression is written once, in the select list. A second copy
 * would bind a new `$n`, and Postgres treats that as a different expression.
 *
 * @param sink - Statement buffer
 * @param names - Group names, in select order
 * @param orderBy - Caller order, or the default group order
 */
export function writeGrouped(sink: Sink, names: readonly string[], orderBy: unknown): void {
  sink.text(ordinals(names.length));
  if (isRecord(orderBy) && Object.keys(orderBy).length > 0) {
    sink.text(" order by ");
    const keys = Object.keys(orderBy);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key === undefined) continue;
      const parsed = parseOrder(key, orderBy[key]);
      if (index > 0) sink.text(", ");
      sink.text(String(names.indexOf(key) + 1));
      sink.text(parsed.dir === "asc" ? " asc" : " desc");
      sink.text(parsed.nulls === "first" ? " nulls first" : " nulls last");
      sink.mark(`o:${key}:${parsed.dir}:${parsed.nulls}`);
    }
    return;
  }
  sink.text(" order by ");
  const parts: string[] = [];
  for (let index = 1; index <= names.length; index += 1) {
    parts.push(`${String(index)} asc nulls last`);
  }
  sink.text(parts.join(", "));
}

function unitOf(value: unknown): BucketUnit | undefined {
  if (
    value === "second" ||
    value === "minute" ||
    value === "hour" ||
    value === "day" ||
    value === "week" ||
    value === "month" ||
    value === "quarter" ||
    value === "year"
  ) {
    return value;
  }
  return undefined;
}

function clockUnit(unit: BucketUnit): boolean {
  return unit === "second" || unit === "minute" || unit === "hour";
}

function weekShift(value: unknown, unit: BucketUnit): 0 | 1 | 2 {
  if (value === undefined) return 0;
  if (unit !== "week") fail("OKM1120", "bucket() weekStart applies to unit week.");
  if (value === "monday") return 0;
  if (value === "sunday") return 1;
  if (value === "saturday") return 2;
  return fail("OKM1120", "bucket() weekStart must be monday, sunday, or saturday.");
}

function temporalKind(dataType: string): "timestamptz" | "timestamp" | "date" | undefined {
  if (dataType === "date") return "date";
  if (dataType === "timestamptz" || dataType.startsWith("timestamptz(")) return "timestamptz";
  if (dataType === "timestamp" || dataType.startsWith("timestamp(")) return "timestamp";
  return undefined;
}

/** `Intl` accepts an IANA name and rejects an offset or a made-up zone. */
function iana(tz: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Decodes a bucket cell.
 *
 * A clock bucket and a `date` column already carry the right codec. A
 * `timestamptz` calendar bucket comes back as `::date`. This file does not
 * import the temporal codecs: that module is already in the startup chunk,
 * and a second import would split it into a chunk the featureless app loads.
 */
function bucketDecode(group: BucketGroup): ((wire: string) => unknown) | undefined {
  if (group.clock || !group.column.dataType.startsWith("timestamptz")) return group.column.decode;
  return decodeDay;
}

/**
 * Reads a calendar bucket's `YYYY-MM-DD` wire as a local date.
 *
 * @param wire - Postgres date text
 * @returns The period start
 */
function decodeDay(wire: string): Temporal.PlainDate {
  const temporal: unknown = (globalThis as { readonly Temporal?: unknown }).Temporal;
  if (typeof temporal !== "object" || temporal === null || !("PlainDate" in temporal)) {
    return fail(
      "OKM1120",
      "Date and time codecs need the Temporal global. okmodel does not ship a polyfill. Use a runtime that provides Temporal, or assign a polyfill to globalThis.Temporal before using these columns.",
    );
  }
  try {
    return (
      temporal as { readonly PlainDate: { from(text: string): Temporal.PlainDate } }
    ).PlainDate.from(wire);
  } catch {
    return fail("OKM1120", `date ${wire} must be YYYY-MM-DD.`);
  }
}

/** Placeholder split out of the select expression so `tz` is bound once. */
const ZONE = "\u0000";

function emitClock(sink: Sink, group: BucketGroup): void {
  const column = `t.${quote(group.column.sql)}`;
  const wrapped = projectExpr(`date_trunc('${group.unit}', ${column}, ${ZONE})`, "timestamptz");
  const at = wrapped.indexOf(ZONE);
  sink.text(wrapped.slice(0, at));
  sink.param(group.tz ?? "");
  sink.text(wrapped.slice(at + ZONE.length));
}

function emitCalendar(sink: Sink, group: BucketGroup): void {
  const column = `t.${quote(group.column.sql)}`;
  sink.text("(date_trunc('");
  sink.text(group.unit);
  sink.text("', ");
  emitLocal(sink, column, group.tz);
  if (group.shift === 0) {
    sink.text("))::date");
    return;
  }
  const days = group.shift === 1 ? "1 day" : "2 days";
  sink.text(" + interval '");
  sink.text(days);
  sink.text("') - interval '");
  sink.text(days);
  sink.text("')::date");
}

function emitLocal(sink: Sink, column: string, tz: string | undefined): void {
  if (tz === undefined) {
    sink.text(column);
    return;
  }
  sink.text("(");
  sink.text(column);
  sink.text(" AT TIME ZONE ");
  sink.param(tz);
  sink.text(")");
}

function ordinals(count: number): string {
  const parts: string[] = [];
  for (let index = 1; index <= count; index += 1) parts.push(String(index));
  return parts.join(", ");
}
