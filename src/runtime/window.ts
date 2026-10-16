/**
 * Window helpers in `select` (spec §10, §13 tool 12).
 *
 * Loaded on the first `find` or `one` whose `select` contains a helper.
 * A plain list of field names never loads this module. `page` does not take
 * a window: its select is field names, and the keyset cursor has no window
 * value to encode.
 */

import { throwNamed } from "../contracts/error.js";
import type { ColumnModel, QuerySchema } from "../dialects/pg/model.js";
import { readSelectFragment, type FragmentPart } from "../dialects/pg/ops/fragment.js";
import { isWindow, type WindowCall } from "../dialects/pg/ops/window.js";
import {
  emitLimit,
  emitOrder,
  emitWhere,
  fail,
  indexes,
  isRecord,
  list,
  parseOrder,
  projectExpr,
  quote,
  refuseHidden,
  type Indexed,
  type ReadBuild,
  type ReadCall,
  type Sink,
} from "./plan.js";
import { refusePrototypeKey } from "./result-name.js";
import { decodeSqlNumber, emitSqlSelect } from "./sql-fragment.js";

const AS_NUMBER = (wire: string): number => Number(wire);
const AS_TEXT = (wire: string): string => wire;

/** Column types `runningTotal` takes. The same set as `sum`. */
const NUMERIC = /^(smallint|integer|bigint|real|double precision|numeric|decimal)\b/;

const OPTION_KEYS = ["as", "orderBy", "partitionBy"] as const;

type Parsed = {
  readonly fn: WindowCall["fn"];
  readonly label: WindowCall["label"];
  readonly column: ColumnModel | undefined;
  readonly partition: readonly ColumnModel[];
  readonly orderBy: unknown;
  readonly as: string;
  readonly decode: (wire: string) => unknown;
  /** Primary key appended to the window order. Rank leaves ties tied. */
  readonly tieBreak: boolean;
};

type Item =
  | { readonly kind: "column"; readonly column: ColumnModel }
  | { readonly kind: "window"; readonly window: Parsed }
  | {
      readonly kind: "sql";
      readonly as: string;
      readonly parts: readonly FragmentPart[];
      readonly textual?: true;
    };

type Spec = {
  readonly items: readonly Item[];
  /** `as` name to a 1-based select ordinal, for `orderBy`. */
  readonly ordinals: ReadonlyMap<string, string>;
};

/**
 * Plans a read whose `select` contains a window helper.
 *
 * The returned call writes the statement. Includes, tenancy, and presets stay
 * on the planner the plain read uses.
 *
 * @param schema - Connected schema
 * @param call - The read, with a window in `select`
 * @returns The same read, with its statement builder set
 */
export function attach(schema: QuerySchema, call: ReadCall): ReadCall {
  const table = indexesOf(schema, call.table);
  return { ...call, build: statement(readSpec(table, call.select)) };
}

function statement(spec: Spec): ReadBuild {
  return (schema, table, sink, outputs, call, hooks) => {
    sink.mark(`${call.op}|${table.model.name}|`);
    if (call.include !== undefined && hooks === undefined) {
      fail("OKM1120", "An include needs the include planner.");
    }
    const includes =
      hooks === undefined || call.include === undefined
        ? []
        : hooks.read(schema, table, call.include, call.all);
    sink.text("select ");
    let column = 0;
    for (const item of spec.items) {
      if (column > 0) sink.text(", ");
      if (item.kind === "column") {
        sink.text(projectExpr(`t.${quote(item.column.sql)}`, item.column.dataType));
        sink.mark(`s:${item.column.field}`);
        outputs?.fields.push({ key: item.column.field, at: column, decode: item.column.decode });
      } else if (item.kind === "sql") {
        emitSqlSelect(table, item.parts, sink, "t");
        sink.text("::text");
        sink.mark(`s:${item.as}`);
        outputs?.fields.push({
          key: item.as,
          at: column,
          decode: item.textual === true ? AS_TEXT : decodeSqlNumber,
        });
      } else {
        emitWindow(table, item.window, sink);
        sink.text("::text");
        outputs?.fields.push({ key: item.window.as, at: column, decode: item.window.decode });
      }
      column += 1;
    }
    if (spec.items.length === 0 && includes.length === 0) sink.text("1");
    for (let index = 0; index < includes.length; index += 1) {
      const include = includes[index];
      if (include === undefined || hooks === undefined) continue;
      column = hooks.select(include, `i${String(index)}`, sink, outputs, column);
    }
    sink.text(" from ");
    sink.text(quote(table.model.sql));
    sink.text(" t");
    for (let index = 0; index < includes.length; index += 1) {
      const include = includes[index];
      if (include === undefined || hooks === undefined) continue;
      hooks.join(schema, include, sink, "t", `i${String(index)}`, 0);
    }
    emitWhere(schema, table, call.where, sink, "t", 0, false, call.after);
    emitResultOrder(table, call.orderBy, sink, spec.ordinals);
    emitLimit(call, sink);
    call.tail?.(sink);
  };
}

/**
 * Orders the result. A key that is a window `as` name is its select position.
 *
 * @param table - The read table
 * @param orderBy - The caller's order
 * @param sink - The statement
 * @param ordinals - `as` name to a 1-based select position
 */
function emitResultOrder(
  table: Indexed,
  orderBy: unknown,
  sink: Sink,
  ordinals: ReadonlyMap<string, string>,
): void {
  if (!isRecord(orderBy) || !mentionsOrdinal(orderBy, ordinals)) {
    emitOrder(table, orderBy, sink, "t");
    return;
  }
  const keys = Object.keys(orderBy);
  sink.text(" order by ");
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    const parsed = parseOrder(key, orderBy[key]);
    if (index > 0) sink.text(", ");
    const ordinal = ordinals.get(key);
    if (ordinal !== undefined) {
      sink.text(ordinal);
    } else {
      const column = table.columns.get(key);
      if (column === undefined) {
        throwNamed(
          "OKM1120",
          key,
          table.names,
          `Field ${key} is not on ${table.model.name}. Accepted names: ${list(table.names)}.`,
        );
      }
      refuseHidden(column);
      sink.text("t.");
      sink.text(quote(column.sql));
    }
    sink.text(parsed.dir === "asc" ? " asc" : " desc");
    sink.text(parsed.nulls === "first" ? " nulls first" : " nulls last");
    sink.mark(`o:${key}:${parsed.dir}:${parsed.nulls}`);
  }
}

/** `true` when `orderBy` names a window result. */
function mentionsOrdinal(
  orderBy: Readonly<Record<string, unknown>>,
  ordinals: ReadonlyMap<string, string>,
): boolean {
  if (ordinals.size === 0) return false;
  for (const key of Object.keys(orderBy)) {
    if (ordinals.has(key)) return true;
  }
  return false;
}

function emitWindow(table: Indexed, win: Parsed, sink: Sink): void {
  sink.mark(`w:${win.fn}:${win.as}:p:${win.partition.map((column) => column.field).join("+")}`);
  if (win.fn === "sum") {
    const column = win.column;
    if (column === undefined) fail("OKM1120", "runningTotal needs a column.");
    sink.text("sum(t.");
    sink.text(quote(column.sql));
    sink.text(")");
  } else {
    sink.text(win.fn);
    sink.text("()");
  }
  sink.text(" over (");
  if (win.partition.length > 0) {
    sink.text("partition by ");
    for (let index = 0; index < win.partition.length; index += 1) {
      const column = win.partition[index];
      if (column === undefined) continue;
      if (index > 0) sink.text(", ");
      sink.text("t.");
      sink.text(quote(column.sql));
    }
  }
  emitOrder(table, win.orderBy, sink, "t");
  if (win.tieBreak) {
    const named = isRecord(win.orderBy) ? Object.keys(win.orderBy) : [];
    for (const field of table.model.primary) {
      if (named.includes(field)) continue;
      const column = table.columns.get(field);
      if (column === undefined) continue;
      sink.text(", t.");
      sink.text(quote(column.sql));
      sink.text(" asc");
    }
  }
  sink.text(")");
}

function readSpec(table: Indexed, select: unknown): Spec {
  if (!Array.isArray(select)) fail("OKM1120", "select must be a list of field names.");
  const items: Item[] = [];
  const ordinals = new Map<string, string>();
  const names = new Set<string>();
  for (const entry of select) {
    if (typeof entry === "string") {
      const column = columnOn(table, entry, "select");
      names.add(column.field);
      items.push({ kind: "column", column });
      continue;
    }
    const sql = readSelectFragment(entry);
    if (sql !== undefined) {
      const as = readAs(sql.as, "fragment");
      if (names.has(as) || table.columns.has(as)) {
        fail(
          "OKM1120",
          `fragment as ${as} clashes with a column of ${table.model.name}.`,
          "Pick an as name that is not a column.",
        );
      }
      names.add(as);
      ordinals.set(as, String(items.length + 1));
      items.push(
        sql.textual === true
          ? { kind: "sql", as, parts: sql.parts, textual: true }
          : { kind: "sql", as, parts: sql.parts },
      );
      continue;
    }
    if (!isWindow(entry)) {
      fail(
        "OKM1120",
        "select takes field names or a window helper. A plain object is not a window.",
        "Pass rowNumber, rank, denseRank, or runningTotal.",
      );
    }
    const win = readWindow(table, entry, names);
    names.add(win.as);
    ordinals.set(win.as, String(items.length + 1));
    items.push({ kind: "window", window: win });
  }
  return { items, ordinals };
}

function readWindow(table: Indexed, call: WindowCall, taken: ReadonlySet<string>): Parsed {
  if (!isRecord(call)) fail("OKM1120", "A window helper was not created by its function.");
  for (const key of Object.keys(call)) {
    if (key === "label" || key === "fn" || key === "column") continue;
    if (OPTION_KEYS.includes(key as (typeof OPTION_KEYS)[number])) continue;
    fail(
      "OKM1120",
      `${call.label} does not take ${key}. Accepted: partitionBy, orderBy, as.`,
      "Pass partitionBy, orderBy, and as.",
    );
  }
  const as = readAs(call.as, call.label);
  if (taken.has(as) || table.columns.has(as)) {
    fail(
      "OKM1120",
      `${call.label} as ${as} clashes with a column of ${table.model.name}.`,
      "Pick an as name that is not a column.",
    );
  }
  const partition = readPartition(table, call.partitionBy, call.label);
  if (!isRecord(call.orderBy) || Object.keys(call.orderBy).length === 0) {
    fail(
      "OKM1120",
      `${call.label} needs orderBy, the order inside the group.`,
      'Pass orderBy: { field: "desc" }.',
    );
  }
  for (const field of Object.keys(call.orderBy)) columnOn(table, field, `${call.label} orderBy`);
  let column: ColumnModel | undefined;
  let decode: (wire: string) => unknown = AS_NUMBER;
  if (call.fn === "sum") {
    if (typeof call.column !== "string") {
      fail("OKM1120", "runningTotal needs the column to total.");
    }
    column = columnOn(table, call.column, "runningTotal");
    if (!NUMERIC.test(column.dataType)) {
      fail(
        "OKM1124",
        `runningTotal does not apply to ${column.dataType} column ${column.field}. It takes integer, real, and numeric columns.`,
      );
    }
    decode = totalDecode(column);
  }
  return {
    fn: call.fn,
    label: call.label,
    column,
    partition,
    orderBy: call.orderBy,
    as,
    decode,
    tieBreak: call.fn === "row_number" || call.fn === "sum",
  };
}

function readPartition(table: Indexed, value: unknown, label: string): readonly ColumnModel[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    fail(
      "OKM1120",
      `${label} partitionBy needs the fields that form the group.`,
      'Pass partitionBy: ["status"], or leave it out to use the whole result.',
    );
  }
  const columns: ColumnModel[] = [];
  const seen = new Set<string>();
  for (const name of value) {
    if (typeof name !== "string") {
      fail("OKM1120", `${label} partitionBy takes field names.`);
    }
    const column = columnOn(table, name, `${label} partitionBy`);
    if (seen.has(column.field)) {
      fail("OKM1120", `${label} partitionBy lists ${column.field} twice.`);
    }
    seen.add(column.field);
    columns.push(column);
  }
  return columns;
}

function readAs(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(
      "OKM1120",
      `${label} needs as, the name of the result key.`,
      "Set as to a name, such as n.",
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    if ((value.charCodeAt(index) ?? 0) < 32) {
      fail("OKM1120", `${label} as has a control character.`);
    }
  }
  refusePrototypeKey(value, `${label} as`);
  return value;
}

/**
 * Reads a running total with the JavaScript type the column has.
 *
 * The same rule as `sum`: a string column keeps the exact text, a number
 * column becomes a number, and any other codec is refused.
 *
 * @param column - The totaled column
 * @returns The decoder for one wire value
 */
function totalDecode(column: ColumnModel): (wire: string) => unknown {
  const kind = typeof (column.decode?.("0") ?? "");
  if (kind === "string") return AS_TEXT;
  if (kind === "number") return AS_NUMBER;
  return fail(
    "OKM1124",
    `runningTotal needs a column whose value is a number or a string. ${column.field} reads as ${kind}.`,
  );
}

function columnOn(table: Indexed, name: string, where: string): ColumnModel {
  const column = table.columns.get(name);
  if (column === undefined) {
    throwNamed(
      "OKM1120",
      name,
      table.names,
      `Field ${name} is not on ${table.model.name}. ${where} accepts: ${list(table.names)}.`,
    );
  }
  if (where !== "select") refuseHidden(column);
  return column;
}

function indexesOf(schema: QuerySchema, name: string): Indexed {
  const table = indexes(schema).get(name);
  if (table === undefined) fail("OKM1120", `Table ${name} is not in the schema.`);
  return table;
}
