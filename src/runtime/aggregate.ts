/**
 * Grouped aggregates (spec section 10).
 *
 * `count`, `countDistinct`, `sum`, `avg`, `min`, and `max` over the rows a
 * `where` selects, per `groupBy` group, as lists or as named entries in `select`. The statement is written here and the `where` is written by
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
import { refusePrototypeKey } from "./result-name.js";
import { isOperator, operatorName, operatorValue } from "../dialects/pg/operators.js";
import {
  cell,
  emitOperand,
  emitWhere,
  fail,
  indexes,
  isRecord,
  isTextColumn,
  list,
  orderNamesRelation,
  parseOrder,
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
import { capLimit } from "./limits.js";

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
  "countDistinct",
  "sum",
  "avg",
  "min",
  "max",
  "select",
  "having",
  "orderBy",
  "limit",
  "ignore",
  "route",
  "signal",
  "timeout",
];

/** Column types `sum` and `avg` take. */
const NUMERIC = /^(smallint|integer|bigint|real|double precision|numeric|decimal)\b/;

const AS_NUMBER = (wire: string): unknown => Number(wire);
const GROUPS: Readonly<Record<string, string>> = {
  "d:": "countDistinct",
  "s:": "sum",
  "a:": "avg",
  "n:": "min",
};
const AS_TEXT = (wire: string): unknown => wire;

/** Column types with no order, so `min` and `max` refuse them. */
const UNORDERED = /^(json|jsonb|bytea|point|line|tsvector)\b|\[\]$/;

/** `countDistinct`, `sum`, `avg`, `min`, and `max` in the order the statement writes them. */
const FUNCTIONS = [
  { option: "countDistinct", tag: "d", numeric: false },
  { option: "sum", tag: "s", numeric: true },
  { option: "avg", tag: "a", numeric: true },
  { option: "min", tag: "n", numeric: false },
  { option: "max", tag: "x", numeric: false },
] as const;

type FieldGroup = { readonly kind: "field"; readonly column: ColumnModel };

type Group = FieldGroup | BucketGroup;

/** One aggregate a `having` may name: the SQL it writes and the column that encodes its operand. */
type Slot = { readonly expr: string; readonly column: ColumnModel };

type Spec = {
  readonly groups: readonly Group[];
  /** `count` and each `select` name: what `having` and `orderBy` may name. */
  readonly slots: ReadonlyMap<string, Slot>;
  /** The caller's `having`, checked against `slots` when the statement is written. */
  readonly having: unknown;
  readonly bucketed: boolean;
  readonly count: boolean;
  readonly calls: readonly {
    readonly option: "count" | "countDistinct" | "sum" | "avg" | "min" | "max";
    readonly tag: string;
    /** Absent for a named `count`. */
    readonly column: ColumnModel | undefined;
    /** The flat result key of a `select` entry. The list forms have none. */
    readonly name: string | undefined;
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
  const grouped = spec.groups.length > 0 && mods.all === undefined;
  const dflt = grouped && record.limit === undefined ? session.l?.groupBy : undefined;
  const limit = dflt ?? record.limit;
  if (grouped && limit === undefined) {
    fail("OKM1101", "aggregate() with groupBy needs a limit.");
  }
  const names = groupNames(spec.groups);
  const orderBy = record.orderBy;
  if (orderNamesRelation(indexed, orderBy)) {
    fail(
      "OKM1128",
      "orderBy on a relation is not available in aggregate.",
      "Order by a groupBy field, count, or a select name.",
    );
  }
  if (orderBy !== undefined) {
    if (!isRecord(orderBy)) fail("OKM1120", "orderBy must be an object of fields.");
    const accepted = spec.groups.length > 0 ? [...names, ...spec.slots.keys()] : names;
    for (const field of Object.keys(orderBy)) {
      if (!accepted.includes(field)) {
        const column = indexed.columns.get(field);
        if (column !== undefined) refuseHidden(column);
        throwNamed(
          "OKM1120",
          field,
          accepted,
          `aggregate() orders by a groupBy field, count, or a select name. Accepted names: ${list(accepted)}.`,
        );
      }
    }
  }
  if (record.limit !== undefined) {
    const written = readLimit(record.limit);
    if (grouped) capLimit(written, session.l?.max);
  }
  const base = readCall(
    "find",
    table,
    {
      where: record.where,
      orderBy,
      limit,
      ...(record.ignore !== undefined ? { ignore: record.ignore } : {}),
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
  const call = {
    ...base,
    op: "aggregate" as const,
    build: statement(spec, buckets),
    ...(session.l !== undefined ? { limits: session.l } : {}),
    ...(dflt !== undefined ? { dl: ["groupBy", dflt] as const } : {}),
  };
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
      calls.push(call(option, tag, numeric, column, undefined));
    }
  }
  calls.push(...named(table, record.select, groupNames(grouped.groups)));
  if (!count && calls.length === 0 && grouped.groups.length === 0) {
    fail(
      "OKM1120",
      "aggregate() needs count, countDistinct, sum, avg, min, max, select, or groupBy.",
    );
  }
  return {
    groups: grouped.groups,
    slots: slotsOf(calls),
    having: readHaving(record.having, grouped.groups.length > 0),
    bucketed: grouped.bucketed,
    count,
    calls,
  };
}

/** Compares with a number or a numeric string, which is how a count, sum, or avg reads back. */
function numberText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return value;
  return fail("OKM1121", "A count, sum, or avg compares with a number or a numeric string.");
}

/**
 * Collects what `having` and `orderBy` can name: `count`, and each `select` name.
 *
 * `count` is always there. The list forms have no flat name, so neither can
 * reach them. A sum, avg, count, or countDistinct compares as a number; min and
 * max compare as the column they read.
 */
function slotsOf(calls: Spec["calls"]): ReadonlyMap<string, Slot> {
  const slots = new Map<string, Slot>();
  slots.set("count", { expr: "count(*)", column: counted("count") });
  for (const item of calls) {
    if (item.name === undefined) continue;
    const source = item.column;
    slots.set(item.name, {
      expr: aggregateSql(item),
      column:
        source !== undefined && (item.option === "min" || item.option === "max")
          ? { ...source, field: item.name, sql: item.name }
          : counted(item.name),
    });
  }
  return slots;
}

function readHaving(value: unknown, grouped: boolean): unknown {
  if (value !== undefined && !grouped) {
    fail("OKM1120", "having needs groupBy.", "Add groupBy, or filter the rows with where.");
  }
  return value;
}

function counted(name: string): ColumnModel {
  return {
    field: name,
    sql: name,
    dataType: "numeric",
    encode: numberText,
    decode: undefined,
    hidden: false,
    sensitive: false,
    guarded: false,
    writable: false,
    guardUpdate: false,
  };
}

/** The aggregate as SQL, without the cast that reads it back as text. */
function aggregateSql(item: Spec["calls"][number]): string {
  const column = item.column;
  if (column === undefined) return "count(*)";
  const ref = `t.${quote(column.sql)}`;
  return item.option === "countDistinct" ? `count(distinct ${ref})` : `${item.option}(${ref})`;
}

const HAVING_FORM = "having is an object of aggregate names, or or() of such objects.";

/** Operators `having` takes. The text patterns need a text `min` or `max`. */
const HAVING_OPERATORS = ",eq,not,lt,lte,gt,gte,between,inList,notIn,";
const HAVING_TEXT = ",startsWith,endsWith,contains,like,ilike,";

/** Writes ` having ...`, the same predicate form as `where`, over the aggregate names. */
function emitHaving(
  schema: Parameters<ReadBuild>[0],
  table: Indexed,
  value: unknown,
  slots: ReadonlyMap<string, Slot>,
  sink: Sink,
): void {
  if (isRecord(value) && Object.values(value).every((item) => item === undefined)) return;
  sink.text(" having ");
  sink.mark("h|");
  const fields = (record: Readonly<Record<string, unknown>>): boolean => {
    let wrote = false;
    for (const key of Object.keys(record)) {
      const operand = record[key];
      if (operand === undefined) continue;
      const slot = slots.get(key);
      if (slot === undefined) {
        const names = [...slots.keys()];
        throwNamed(
          "OKM1120",
          key,
          names,
          `having names an aggregate of this call. Accepted names: ${list(names)}.`,
        );
      }
      checkOperator(key, slot, operand);
      if (wrote) sink.text(" and ");
      wrote = true;
      sink.mark(`h:${JSON.stringify(key)}`);
      emitOperand(schema, table, slot.column, operand, sink, "t", 0, false, slot.expr);
    }
    return wrote;
  };
  if (!isOperator(value)) {
    if (!isRecord(value)) fail("OKM1121", HAVING_FORM);
    fields(value);
    return;
  }
  const branches = operatorName(value) === "or" ? operatorValue(value) : undefined;
  if (!Array.isArray(branches)) fail("OKM1121", HAVING_FORM);
  sink.mark(`h:or:${String(branches.length)}|`);
  if (branches.length === 0) {
    sink.text("false");
    return;
  }
  sink.text("(");
  for (let index = 0; index < branches.length; index += 1) {
    const branch: unknown = branches[index];
    if (!isRecord(branch)) fail("OKM1121", "or() branches must be having objects.");
    sink.text(index === 0 ? "(" : " or (");
    if (!fields(branch)) fail("OKM1121", "An or() branch needs at least one aggregate.");
    sink.text(")");
  }
  sink.text(")");
}

/** Refuses an operator `having` does not write, before any SQL. */
function checkOperator(key: string, slot: Slot, value: unknown): void {
  if (!isOperator(value)) return;
  const name = operatorName(value);
  if (name === "not") {
    checkOperator(key, slot, operatorValue(value));
    return;
  }
  if (
    HAVING_OPERATORS.includes(`,${name},`) ||
    (HAVING_TEXT.includes(`,${name},`) && isTextColumn(slot.column.dataType))
  ) {
    return;
  }
  fail(
    "OKM1121",
    `having ${key} does not take ${name}.`,
    "It takes eq, not, lt, lte, gt, gte, between, inList, notIn, and or(). A text min or max also takes startsWith, endsWith, contains, like, and ilike.",
  );
}

/** Checks that the function takes the column's type, and picks how the result is read. */
function call(
  option: (typeof FUNCTIONS)[number]["option"],
  tag: string,
  numeric: boolean,
  column: ColumnModel,
  name: string | undefined,
): Spec["calls"][number] {
  const fits = numeric ? NUMERIC.test(column.dataType) : !UNORDERED.test(column.dataType);
  if (!fits) {
    fail(
      "OKM1124",
      `${option} does not apply to ${column.dataType} column ${column.field}. ${
        numeric
          ? "sum and avg take integer, real, and numeric columns."
          : "countDistinct, min, and max need an ordered type."
      }`,
    );
  }
  const decode =
    option === "countDistinct" ? AS_NUMBER : numeric ? sumDecode(column) : column.decode;
  return { option, tag, column, name, decode };
}

/** Names `select` cannot take: the list-form result keys. */
const RESERVED = ["count", "countDistinct", "sum", "avg", "min", "max"];

/**
 * Reads `select: { name: { sum: "field" } }`.
 *
 * Each entry is one function and gives one flat result key. A name that is a
 * group field, a bucket `as`, a list-form result key, or a prototype key is
 * refused before any SQL.
 */
function named(
  table: Indexed,
  value: unknown,
  groupKeys: readonly string[],
): readonly Spec["calls"][number][] {
  if (value === undefined) return [];
  if (!isRecord(value)) fail("OKM1120", "select must be an object of named aggregates.");
  const out: Spec["calls"][number][] = [];
  for (const [name, entry] of Object.entries(value)) {
    refusePrototypeKey(name, "select name");
    if (RESERVED.includes(name) || groupKeys.includes(name)) {
      fail(
        "OKM1120",
        `select name ${name} is already a result key of this call.`,
        "Use another name. A group field, a bucket as, and count, countDistinct, sum, avg, min, and max are taken.",
      );
    }
    const keys = isRecord(entry) ? Object.keys(entry) : [];
    const option = keys[0];
    const fn = FUNCTIONS.find((item) => item.option === option);
    if (keys.length !== 1 || (option !== "count" && fn === undefined)) {
      fail(
        "OKM1120",
        `select ${name} needs exactly one of count, countDistinct, sum, avg, min, or max.`,
      );
    }
    const arg = (entry as Record<string, unknown>)[option as string];
    if (fn === undefined) {
      if (arg !== true) fail("OKM1120", `select ${name}: count is true when you want a row count.`);
      out.push({ option: "count", tag: "c", column: undefined, name, decode: AS_NUMBER });
      continue;
    }
    const [column] = columns(table, [arg], fn.option);
    out.push(call(fn.option, fn.tag, fn.numeric, column as ColumnModel, name));
  }
  return out;
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
        .map((item) =>
          item.name === undefined
            ? `${item.tag}:${item.column?.field}`
            : `m${item.tag}:${JSON.stringify(item.name)}:${item.column?.field ?? ""}`,
        )
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
      const column = item.column;
      const sql = aggregateSql(item);
      put(
        sink,
        outputs,
        wrote,
        column === undefined || item.option === "countDistinct" || numericOption(item.option)
          ? `${sql}::text`
          : projectExpr(sql, column.dataType),
        {
          key: item.name === undefined ? `${item.tag}:${column?.field}` : `m:${item.name}`,
          decode: item.decode,
        },
      );
    }
    sink.text(" from ");
    sink.text(quote(table.model.sql));
    sink.text(" t");
    emitWhere(schema, table, call.where, sink, "t", 0);
    if (spec.groups.length > 0) {
      sink.text(" group by ");
      if (spec.bucketed) {
        if (buckets === undefined) fail("OKM1120", "bucket group");
        buckets.writeGrouped(sink, groupNames(spec.groups));
      } else {
        sink.text(spec.groups.map((group) => fieldRef(group)).join(", "));
      }
      if (spec.having !== undefined) emitHaving(schema, table, spec.having, spec.slots, sink);
      emitGroupOrder(spec, call.orderBy, sink);
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

/**
 * Writes ` order by` over the group keys and the aggregate names.
 *
 * A group key orders by its own column, or by its select position when the call
 * has a bucket. An aggregate orders by its expression, so a `min` or `max` of a
 * timestamp sorts as a timestamp and not as the text the select list returns.
 * With no `orderBy`, groups come in `groupBy` order.
 */
function emitGroupOrder(spec: Spec, orderBy: unknown, sink: Sink): void {
  const names = groupNames(spec.groups);
  const keys = isRecord(orderBy) ? Object.keys(orderBy) : [];
  sink.text(" order by ");
  if (!isRecord(orderBy) || keys.length === 0) {
    sink.text(
      spec.groups
        .map((group, index) =>
          spec.bucketed
            ? `${String(index + 1)} asc nulls last`
            : `${fieldRef(group)} asc nulls last`,
        )
        .join(", "),
    );
    return;
  }
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    const parsed = parseOrder(key, orderBy[key]);
    const at = names.indexOf(key);
    const group = spec.groups[at];
    const slot = spec.slots.get(key);
    if (index > 0) sink.text(", ");
    sink.text(
      group === undefined
        ? (slot?.expr ?? fail("OKM1120", `orderBy ${key} is not a group or an aggregate.`))
        : spec.bucketed
          ? String(at + 1)
          : fieldRef(group),
    );
    sink.text(parsed.dir === "asc" ? " asc" : " desc");
    sink.text(parsed.nulls === "first" ? " nulls first" : " nulls last");
    sink.mark(`o:${key}:${parsed.dir}:${parsed.nulls}`);
  }
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

function numericOption(option: string): boolean {
  return option === "sum" || option === "avg";
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
      } else if (tag === "m:") {
        item[name] = cell(value, field.decode);
      } else {
        const group = GROUPS[tag] ?? "max";
        const into = (item[group] ??= {}) as Record<string, unknown>;
        into[name] = cell(value, field.decode);
      }
    }
    items.push(item);
  }
  return items;
}
