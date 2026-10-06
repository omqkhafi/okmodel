/**
 * Grouped aggregates (spec section 10).
 *
 * `count`, `sum`, `avg`, `min`, and `max` over the rows a `where` selects, per
 * `groupBy` group. The statement is written here and the `where` is written by
 * the planner's `emitWhere`, so the tenant and active-set predicates apply to
 * every aggregate exactly as they apply to a `find`. This module loads on the
 * first `aggregate()`.
 *
 * Not here: `having`, `bucket`, and ordering by an aggregate. A hidden column
 * cannot be grouped or aggregated, so an aggregate never shows what a read hides.
 */

import { OkmError, throwNamed } from "../contracts/error.js";
import type { ColumnModel } from "../dialects/pg/model.js";
import { attachHttp, readCall, readHandle, type Mods, type Session } from "./client.js";
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
  rejectKeys,
  type ArchiveView,
  type Built,
  type Indexed,
  type Plan,
  type ReadBuild,
  type Sink,
} from "./plan.js";

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

type Spec = {
  readonly groups: readonly ColumnModel[];
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
    return plan(session, table, options, mods, view);
  } catch (error) {
    throw error instanceof OkmError ? attachHttp(session.http, error) : error;
  }
}

function plan(
  session: Session,
  table: string,
  options: object,
  mods: Mods,
  view: ArchiveView | undefined,
): Promise<unknown> & Record<string, unknown> {
  const record: Record<string, unknown> = isRecord(options) ? options : {};
  rejectKeys(record, OPTIONS, "aggregate");
  const indexed = indexes(session.schema).get(table);
  if (indexed === undefined) fail("OKM1120", `Table ${table} is not in the schema.`);
  const spec = parse(indexed, record);
  if (spec.groups.length > 0 && record.limit === undefined && mods.all === undefined) {
    fail("OKM1101", "aggregate() with groupBy needs a limit, or .all(reason) for every group.");
  }
  const orderBy = record.orderBy;
  if (orderBy !== undefined) {
    if (!isRecord(orderBy)) fail("OKM1120", "orderBy must be an object of fields.");
    for (const field of Object.keys(orderBy)) {
      if (!spec.groups.some((column) => column.field === field)) {
        throwNamed(
          "OKM1120",
          field,
          spec.groups.map((column) => column.field),
          `aggregate() orders by a groupBy field. Accepted names: ${list(spec.groups.map((column) => column.field))}.`,
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
  const call = { ...base, op: "aggregate" as const, build: statement(spec) };
  return readHandle(session, table, call, mods, (compiled, rows) => decode(compiled, rows));
}

function parse(table: Indexed, record: Record<string, unknown>): Spec {
  const groups = columns(table, record.groupBy, "groupBy");
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
  if (!count && calls.length === 0 && groups.length === 0) {
    fail("OKM1120", "aggregate() needs count, sum, avg, min, max, or groupBy.");
  }
  return { groups, count, calls };
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

/** Writes `select ... from ... where ... group by ... order by ... limit`. */
function statement(spec: Spec): ReadBuild {
  return (schema, table, sink, outputs, call) => {
    sink.mark(
      `aggregate|${table.model.name}|g:${spec.groups.map((column) => column.field).join(",")}|c:${String(spec.count)}|${spec.calls
        .map((item) => `${item.tag}:${item.column.field}`)
        .join(",")}|`,
    );
    sink.text("select ");
    const wrote = { at: 0 };
    for (const column of spec.groups) {
      put(sink, outputs, wrote, projectExpr(`t.${quote(column.sql)}`, column.dataType), {
        key: `g:${column.field}`,
        decode: column.decode,
      });
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
      sink.text(spec.groups.map((column) => `t.${quote(column.sql)}`).join(", "));
      if (isRecord(call.orderBy) && Object.keys(call.orderBy).length > 0) {
        emitOrder(table, call.orderBy, sink, "t");
      } else {
        sink.text(" order by ");
        sink.text(spec.groups.map((column) => `t.${quote(column.sql)} asc nulls last`).join(", "));
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
