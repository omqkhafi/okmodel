/**
 * Grouped aggregates (spec section 10).
 *
 * `count`, `sum`, `avg`, `min`, and `max` over the rows a `where` selects, per
 * `groupBy` group. The statement is written here and the `where` is written by
 * the planner's `emitWhere`, so the tenant and active-set predicates apply to
 * every aggregate exactly as they apply to a `find`. This module loads on the
 * first `aggregate()`.
 *
 * Not here: `having`, ordering by an aggregate, and the time-zone date helpers
 * (tool 5). A hidden column cannot be grouped or aggregated, so an aggregate
 * never shows what a read hides.
 *
 * `bucket()` is a tagged helper. Its validation and SQL load in their own
 * chunk, and only when `groupBy` contains one. A request object cannot create
 * one. A NULL timestamp is one group: the result key is present and the value
 * is null.
 */

import { OkmError, throwNamed } from "../contracts/error.js";
import type { ColumnModel } from "../dialects/pg/model.js";
import {
  attachHttp,
  queryHandle,
  readCall,
  readHandle,
  type Mods,
  type Session,
} from "./client.js";
import type { BucketChunk, BucketGroup } from "./bucket-group.js";
import {
  cell,
  emitOrder,
  emitWhere,
  fail,
  indexes,
  isRecord,
  list,
  projectExpr,
  quote,
  readLimit,
  refuseHidden,
  rejectKeys,
  type ArchiveView,
  type Built,
  type Indexed,
  type Plan,
  type ReadBuild,
  type Sink,
} from "./plan.js";

/**
 * Same symbol `bucket()` registers.
 *
 * Testing it here avoids importing the helper module into this chunk.
 */
const BUCKET = Symbol.for("okmodel.bucket");

let bucketChunk: Promise<BucketChunk> | undefined;

function loadBucketGroup(): Promise<BucketChunk> {
  return (bucketChunk ??= import("./bucket-group.js"));
}

const OPTIONS = [
  "where",
  "groupBy",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "orderBy",
  "limit",
  "route",
  "signal",
  "timeout",
];

/** Column types `sum` and `avg` take. */
const NUMERIC = /^(smallint|integer|bigint|real|double precision|numeric|decimal)\b/;

const AS_NUMBER = (wire: string): unknown => Number(wire);
const AS_TEXT = (wire: string): unknown => wire;

/** Column types with no order, so `min` and `max` refuse them. */
const UNORDERED = /^(json|jsonb|bytea|point|line|tsvector)\b|\[\]$/;

/** `sum`, `avg`, `min`, and `max` in the order the statement writes them. */
const FUNCTIONS = [
  { option: "sum", tag: "s", numeric: true },
  { option: "avg", tag: "a", numeric: true },
  { option: "min", tag: "n", numeric: false },
  { option: "max", tag: "x", numeric: false },
] as const;

type FieldGroup = { readonly kind: "field"; readonly column: ColumnModel };

type Group = FieldGroup | BucketGroup;

type Spec = {
  readonly groups: readonly Group[];
  readonly bucketed: boolean;
  readonly count: boolean;
  readonly calls: readonly {
    readonly option: "sum" | "avg" | "min" | "max";
    readonly tag: string;
    readonly column: ColumnModel;
    /** How the result is read: the column's codec, or the exact text or number of a sum. */
    readonly decode: ((wire: string) => unknown) | undefined;
  }[];
};

/**
 * Builds the handle for one `aggregate()` call.
 *
 * @param session - Client session
 * @param table - Table name
 * @param options - `where`, `groupBy`, the aggregates, `orderBy`, and `limit`
 * @param mods - `.all` reason, signal, and timeout
 * @param view - Archive visibility
 * @returns A handle that resolves to the grouped rows
 */
export function build(
  session: Session,
  table: string,
  options: object,
  mods: Mods,
  view: ArchiveView | undefined,
): Promise<unknown> & Record<string, unknown> {
  try {
    if (seesBucket(options)) return bucketHandle(session, table, options, mods, view);
    return plan(session, table, options, mods, view);
  } catch (error) {
    throw error instanceof OkmError ? attachHttp(session.http, error) : error;
  }
}

/**
 * Plans an aggregate that contains a bucket, after the bucket chunk loads.
 *
 * `await`, `sql()`, and `inspect()` each load that chunk. A plain aggregate
 * never calls this.
 */
function bucketHandle(
  session: Session,
  table: string,
  options: object,
  mods: Mods,
  view: ArchiveView | undefined,
): Promise<unknown> & Record<string, unknown> {
  const open = (): Promise<{ it: Promise<unknown> & Record<string, unknown> }> =>
    loadBucketGroup().then((mod) => {
      try {
        return { it: plan(session, table, options, mods, view, mod) };
      } catch (error) {
        throw error instanceof OkmError ? attachHttp(session.http, error) : error;
      }
    });
  return queryHandle(() => open().then((box) => box.it), {
    inspect: () => open().then((box) => (box.it.inspect as () => unknown)()),
    sql: () => open().then((box) => (box.it.sql as () => unknown)()),
    all: (reason: string) => build(session, table, options, { ...mods, all: reason }, view),
  }) as unknown as Promise<unknown> & Record<string, unknown>;
}

function seesBucket(options: object): boolean {
  if (!isRecord(options)) return false;
  const groupBy = options.groupBy;
  if (!Array.isArray(groupBy)) return false;
  for (const item of groupBy) {
    if (typeof item === "object" && item !== null && BUCKET in item) return true;
  }
  return false;
}

function plan(
  session: Session,
  table: string,
  options: object,
  mods: Mods,
  view: ArchiveView | undefined,
  buckets?: BucketChunk,
): Promise<unknown> & Record<string, unknown> {
  const record: Record<string, unknown> = isRecord(options) ? options : {};
  rejectKeys(record, OPTIONS, "aggregate");
  const indexed = indexes(session.schema).get(table);
  if (indexed === undefined) fail("OKM1120", `Table ${table} is not in the schema.`);
  const spec = parse(indexed, record, buckets);
  if (spec.groups.length > 0 && record.limit === undefined && mods.all === undefined) {
    fail("OKM1101", "aggregate() with groupBy needs a limit, or .all(reason) for every group.");
  }
  const names = groupNames(spec.groups);
  const orderBy = record.orderBy;
  if (orderBy !== undefined) {
    if (!isRecord(orderBy)) fail("OKM1120", "orderBy must be an object of fields.");
    for (const field of Object.keys(orderBy)) {
      if (!names.includes(field)) {
        const column = indexed.columns.get(field);
        if (column !== undefined) refuseHidden(column);
        throwNamed(
          "OKM1120",
          field,
          names,
          `aggregate() orders by a groupBy field. Accepted names: ${list(names)}.`,
        );
      }
    }
  }
  if (record.limit !== undefined) readLimit(record.limit);
  const base = readCall(
    "find",
    table,
    {
      where: record.where,
      orderBy,
      limit: record.limit,
      signal: record.signal,
      timeout: record.timeout,
      route: record.route,
    },
    mods.all,
    session.scope,
    session.schema.model[table],
    session.schema,
    view,
  );
  const call = { ...base, op: "aggregate" as const, build: statement(spec, buckets) };
  return readHandle(session, table, call, mods, (compiled, rows) => decode(compiled, rows));
}

function parse(table: Indexed, record: Record<string, unknown>, buckets?: BucketChunk): Spec {
  const grouped = readGroups(table, record.groupBy, buckets);
  const count = record.count === true;
  if (record.count !== undefined && typeof record.count !== "boolean") {
    fail("OKM1120", "count is true when you want a row count.");
  }
  const calls: Spec["calls"][number][] = [];
  for (const { option, tag, numeric } of FUNCTIONS) {
    for (const column of columns(table, record[option], option)) {
      const fits = numeric ? NUMERIC.test(column.dataType) : !UNORDERED.test(column.dataType);
      if (!fits) {
        fail(
          "OKM1124",
          `${option} does not apply to ${column.dataType} column ${column.field}. ${
            numeric
              ? "sum and avg take integer, real, and numeric columns."
              : "min and max need an ordered type."
          }`,
        );
      }
      calls.push({ option, tag, column, decode: numeric ? sumDecode(column) : column.decode });
    }
  }
  if (!count && calls.length === 0 && grouped.groups.length === 0) {
    fail("OKM1120", "aggregate() needs count, sum, avg, min, max, or groupBy.");
  }
  return { groups: grouped.groups, bucketed: grouped.bucketed, count, calls };
}

/**
 * Reads a `sum` or an `avg` with the JavaScript type the column has.
 *
 * A string column (`numeric`, or `bigint` as string) gets the exact text
 * Postgres returns, so no digit is lost. A number column gets a number. A
 * column with another codec has no honest total, so it is refused.
 */
function sumDecode(column: ColumnModel): (wire: string) => unknown {
  const kind = typeof (column.decode?.("0") ?? "");
  if (kind === "string") return AS_TEXT;
  if (kind === "number") return AS_NUMBER;
  return fail(
    "OKM1124",
    `sum and avg need a column whose value is a number or a string. ${column.field} reads as ${kind}.`,
  );
}

function columns(table: Indexed, value: unknown, option: string): readonly ColumnModel[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("OKM1120", `${option} must be a list of field names.`);
  const out: ColumnModel[] = [];
  for (const name of value) {
    const column = typeof name === "string" ? table.columns.get(name) : undefined;
    if (typeof name !== "string" || column === undefined) {
      throwNamed(
        "OKM1120",
        String(name),
        table.names,
        `Field ${String(name)} is not on ${table.model.name}. Accepted names: ${list(table.names)}.`,
      );
    }
    if (column.hidden) {
      fail("OKM1120", `Field ${column.field} is hidden, so ${option} cannot read it.`);
    }
    out.push(column);
  }
  return out;
}

function groupNames(groups: readonly Group[]): readonly string[] {
  const names: string[] = [];
  for (const group of groups) names.push(group.kind === "field" ? group.column.field : group.as);
  return names;
}

function readGroups(
  table: Indexed,
  value: unknown,
  buckets: BucketChunk | undefined,
): { readonly groups: readonly Group[]; readonly bucketed: boolean } {
  if (value === undefined) return { groups: [], bucketed: false };
  if (!Array.isArray(value)) fail("OKM1120", "groupBy must be a list of field names.");
  const fields = new Set<string>();
  const aliases = new Set<string>();
  const groups: Group[] = [];
  let bucketed = false;
  for (const item of value) {
    if (typeof item === "object" && item !== null && BUCKET in item) {
      if (buckets === undefined) fail("OKM1120", "bucket group");
      groups.push(buckets.readBucket(table, item, fields, aliases));
      bucketed = true;
      continue;
    }
    const column = typeof item === "string" ? table.columns.get(item) : undefined;
    if (typeof item !== "string" || column === undefined) {
      throwNamed(
        "OKM1120",
        String(item),
        table.names,
        `Field ${String(item)} is not on ${table.model.name}. Accepted names: ${list(table.names)}.`,
      );
    }
    if (column.hidden) {
      fail("OKM1120", `Field ${column.field} is hidden, so groupBy cannot read it.`);
    }
    if (aliases.has(column.field)) {
      fail("OKM1120", `group field ${column.field} clashes with a bucket as.`);
    }
    fields.add(column.field);
    groups.push({ kind: "field", column });
  }
  return { groups, bucketed };
}

/** Writes `select ... from ... where ... group by ... order by ... limit`. */
function statement(spec: Spec, buckets: BucketChunk | undefined): ReadBuild {
  return (schema, table, sink, outputs, call) => {
    sink.mark(
      `aggregate|${table.model.name}|g:${groupMark(spec.groups)}|c:${String(spec.count)}|${spec.calls
        .map((item) => `${item.tag}:${item.column.field}`)
        .join(",")}|`,
    );
    sink.text("select ");
    const wrote = { at: 0 };
    for (const group of spec.groups) {
      if (group.kind === "field") {
        put(
          sink,
          outputs,
          wrote,
          projectExpr(`t.${quote(group.column.sql)}`, group.column.dataType),
          {
            key: `g:${group.column.field}`,
            decode: group.column.decode,
          },
        );
      } else {
        if (buckets === undefined) fail("OKM1120", "bucket group");
        buckets.writeBucket(sink, outputs, wrote, group);
      }
    }
    if (spec.count) put(sink, outputs, wrote, "count(*)::text", { key: "c:", decode: undefined });
    for (const item of spec.calls) {
      const ref = `t.${quote(item.column.sql)}`;
      const expr =
        item.option === "sum" || item.option === "avg"
          ? `${item.option}(${ref})::text`
          : projectExpr(`${item.option}(${ref})`, item.column.dataType);
      put(sink, outputs, wrote, expr, {
        key: `${item.tag}:${item.column.field}`,
        decode: item.decode,
      });
    }
    sink.text(" from ");
    sink.text(quote(table.model.sql));
    sink.text(" t");
    emitWhere(schema, table, call.where, sink, "t", 0);
    if (spec.groups.length > 0) {
      sink.text(" group by ");
      if (spec.bucketed) {
        if (buckets === undefined) fail("OKM1120", "bucket group");
        buckets.writeGrouped(sink, groupNames(spec.groups), call.orderBy);
      } else {
        sink.text(spec.groups.map((group) => fieldRef(group)).join(", "));
        if (isRecord(call.orderBy) && Object.keys(call.orderBy).length > 0) {
          emitOrder(table, call.orderBy, sink, "t");
        } else {
          sink.text(" order by ");
          sink.text(spec.groups.map((group) => `${fieldRef(group)} asc nulls last`).join(", "));
        }
      }
    }
    if (call.limit !== undefined) {
      const limit = String(call.limit as number);
      sink.text(" limit ");
      sink.param(limit);
      sink.mark(`l:${limit}`);
    }
    if (typeof call.all === "string") sink.mark(`all:${call.all}`);
  };
}

/** Field-only marks stay the column names, so an existing plan key does not move. */
function groupMark(groups: readonly Group[]): string {
  const parts: string[] = [];
  for (const group of groups) {
    parts.push(
      group.kind === "field"
        ? group.column.field
        : `b:${group.column.field}:${group.as}:${group.unit}:${String(group.shift)}`,
    );
  }
  return parts.join(",");
}

function fieldRef(group: Group): string {
  if (group.kind !== "field") return fail("OKM1120", "bucket group");
  return `t.${quote(group.column.sql)}`;
}

function put(
  sink: Sink,
  outputs: Built | undefined,
  wrote: { at: number },
  expr: string,
  out: { readonly key: string; readonly decode: ((wire: string) => unknown) | undefined },
): void {
  if (wrote.at > 0) sink.text(", ");
  sink.text(expr);
  outputs?.fields.push({ key: out.key, at: wrote.at, decode: out.decode });
  wrote.at += 1;
}

function decode(
  compiled: Plan,
  rows: readonly (readonly (string | null)[])[],
): readonly Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const row of rows) {
    const item: Record<string, unknown> = {};
    for (const field of compiled.outputs.fields) {
      const value = row[field.at];
      const tag = field.key.slice(0, 2);
      const name = field.key.slice(2);
      if (tag === "g:") {
        item[name] = cell(value, field.decode);
      } else if (tag === "c:") {
        item.count = Number(value ?? 0);
      } else {
        const group = tag === "s:" ? "sum" : tag === "a:" ? "avg" : tag === "n:" ? "min" : "max";
        const into = (item[group] ??= {}) as Record<string, unknown>;
        into[name] = cell(value, field.decode);
      }
    }
    items.push(item);
  }
  return items;
}
