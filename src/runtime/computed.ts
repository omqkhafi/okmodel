/**
 * `computed`: relation aggregates inside the same statement as the read.
 *
 * Loaded on the first read that sets `computed`. A read without it never
 * imports this module, and the startup graph holds only the option name and
 * the import call.
 *
 * One statement holds the whole read. A `many` or `manyThrough` relation
 * becomes one grouped subquery joined back to the parent, never a correlated
 * scalar subquery per row.
 *
 * - `find` and `one` without a computed filter or order first take the parent
 *   page in a materialized CTE, so each grouped subquery reads only the
 *   children of that page. A threshold in `where` (`count` at least k,
 *   `exists`) is an `EXISTS ... OFFSET k - 1 LIMIT 1` inside that page.
 * - A filter that is not a threshold, an order by a computed value, `count`,
 *   and `exists` need the value for every parent. The grouped subquery then
 *   reads the whole relation.
 */

import { throwNamed } from "../contracts/error.js";
import {
  emitAnyRow,
  emitFilter,
  emitMaterialized,
  emitSkipOne,
} from "../dialects/pg/computed-sql.js";
import type { ColumnModel, QuerySchema, RelationModel } from "../dialects/pg/model.js";
import { isFragmentParts, sqlExpression, type FragmentPart } from "../dialects/pg/ops/fragment.js";
import { isOperator, operatorName, operatorValue, tag } from "../dialects/pg/operators.js";
import { NUMERIC, UNORDERED, numberText, readsAs } from "./numeric-type.js";
import {
  emitConditions,
  emitLimit,
  emitOperand,
  emitOrder,
  emitRelationFrom,
  emitVisibility,
  emitWhere,
  fail,
  indexes,
  isRecord,
  list,
  needsOperatorSql,
  projectExpr,
  quote,
  refuseHidden,
  selectedColumns,
  type Indexed,
  type Keyset,
  type ReadBuild,
  type ReadCall,
  type Sink,
} from "./plan.js";
import { refusePrototypeKey } from "./result-name.js";
import { decodeSqlNumber, emitSqlSelect, type NameHook } from "./sql-fragment.js";

type Verb = "count" | "exists" | "sum" | "avg" | "min" | "max";

const VERBS: readonly string[] = ["count", "exists", "sum", "avg", "min", "max"];
const VERB_LIST = "count, exists, sum, avg, min, and max";
const PAGE = "okm_pg";
const AS_NUMBER = (wire: string): unknown => Number(wire);
const AS_TEXT = (wire: string): unknown => wire;
const AS_BOOLEAN = (wire: string): unknown => wire === "true" || wire === "t";

/** What an aggregate compares as in `where`, and how it reads back. */
type Shape = {
  readonly dataType: string;
  readonly encode: (value: unknown) => string;
  readonly decode: ((wire: string) => unknown) | undefined;
};

/** One grouped subquery: every aggregate over one relation. */
type Group = {
  readonly index: number;
  readonly relation: RelationModel;
  readonly child: Indexed;
  readonly aggs: Agg[];
};

/** One verb call, such as `u.posts.count({ where })`. */
type Agg = {
  readonly group: Group;
  /** The `ident` name the callback's fragment holds in place of the value. */
  readonly token: string;
  readonly verb: Verb;
  readonly column: ColumnModel | undefined;
  readonly parts: readonly FragmentPart[] | undefined;
  readonly distinct: boolean;
  readonly where: unknown;
  readonly shape: Shape;
  /** Column name in the grouped subquery. Empty until the statement is laid out. */
  slot: string;
};

/** One computed result: a bare aggregate, or a fragment over aggregates and same-row fields. */
type Item = {
  readonly name: string;
  readonly agg: Agg | undefined;
  readonly parts: readonly FragmentPart[];
  readonly shape: Shape;
  /** The aggregates it is made of. */
  readonly used: readonly Agg[];
  /** Stands in for the value in `where`. */
  readonly column: ColumnModel;
};

/** A `where` entry on a computed name. */
type Cond = {
  readonly item: Item;
  readonly value: unknown;
  readonly threshold: Threshold | undefined;
};

/** A `count` or `exists` comparison that `EXISTS ... OFFSET` proves. */
type Threshold =
  | { readonly kind: "const"; readonly pass: boolean }
  | { readonly kind: "exists"; readonly negate: boolean; readonly skip: number };

/** What `attach` parsed. `ReadCall.computed` holds it afterwards. */
type Computed = {
  readonly items: readonly Item[];
  readonly tokens: ReadonlyMap<string, Agg>;
  readonly groups: readonly Group[];
  /** `where` without the computed names. */
  readonly plain: unknown;
  readonly conds: readonly Cond[];
  readonly orders: ReadonlyMap<string, Item>;
  /** True when every parent needs a value, so no page CTE is used. */
  readonly full: boolean;
  /** Related tables and the columns that link them, for the foreign-key index warning. */
  readonly keys: readonly {
    readonly table: string;
    readonly relation: string;
    readonly columns: readonly string[];
  }[];
};

type Ctx = {
  readonly schema: QuerySchema;
  readonly table: Indexed;
  readonly groups: Group[];
  readonly tokens: Map<string, Agg>;
};

const NUMBER_SHAPE: Shape = { dataType: "numeric", encode: numberText, decode: decodeSqlNumber };
const COUNT_SHAPE: Shape = { dataType: "bigint", encode: numberText, decode: AS_NUMBER };
const EXISTS_SHAPE: Shape = {
  dataType: "boolean",
  encode: (value) =>
    typeof value === "boolean"
      ? String(value)
      : fail("OKM1121", "exists compares with true or false."),
  decode: AS_BOOLEAN,
};

const parsed = new WeakSet<object>();

/**
 * Parses `computed` and sets the statement builder.
 *
 * @param schema - Connected schema
 * @param call - The read, with `computed` set
 * @returns The same read, with the parsed `computed` and its statement builder
 */
export async function attach(schema: QuerySchema, call: ReadCall): Promise<ReadCall> {
  const raw = call.computed;
  if (typeof raw === "object" && raw !== null && parsed.has(raw)) return call;
  const table = indexes(schema).get(call.table);
  if (table === undefined) return call;
  refuseCombination(call);
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    fail(
      "OKM1120",
      "computed must be an object of name to callback.",
      "Pass computed: { postCount: (u) => u.posts.count() }.",
    );
  }
  const ctx: Ctx = { schema, table, groups: [], tokens: new Map() };
  const items = Object.keys(raw).map((name) => readItem(ctx, name, raw[name]));
  const names = new Map(items.map((item) => [item.name, item]));
  const conds: Cond[] = [];
  const plain = splitWhere(call.where, names, conds);
  const orders = new Map<string, Item>();
  if (isRecord(call.orderBy)) {
    for (const key of Object.keys(call.orderBy)) {
      const item = names.get(key);
      if (item !== undefined) orders.set(key, item);
    }
  }
  const counting = call.op === "count" || call.op === "exists";
  const info: Computed = {
    items,
    tokens: ctx.tokens,
    groups: ctx.groups,
    plain,
    conds,
    orders,
    full: counting || orders.size > 0 || conds.some((cond) => cond.threshold === undefined),
    keys: ctx.groups.flatMap((group) =>
      group.relation.through === undefined
        ? [
            {
              table: group.child.model.sql,
              relation: group.relation.name,
              columns: group.relation.remote,
            },
          ]
        : [],
    ),
  };
  parsed.add(info);
  const lazy = ctx.groups.some((group) =>
    group.aggs.some((agg) => agg.where !== undefined && needsOperatorSql(group.child, agg.where)),
  );
  if (lazy) await import("./operator-sql.js");
  return { ...call, computed: info, build: statement };
}

function refuseCombination(call: ReadCall): void {
  const clash =
    call.build !== undefined
      ? "a window helper in select, distinct, or distinctOn"
      : call.rel !== undefined
        ? "an order by a relation"
        : call.keyCursor !== undefined
          ? "a page ordered by a hidden field"
          : call.tail !== undefined
            ? "a row lock"
            : undefined;
  if (clash === undefined) return;
  fail(
    "OKM1120",
    `computed does not combine with ${clash}.`,
    "Read the computed values in a separate call, or drop the other option.",
  );
}

function readItem(ctx: Ctx, name: string, callback: unknown): Item {
  const { table } = ctx;
  refusePrototypeKey(name, "computed");
  if (table.columns.has(name) || table.relations.has(name)) {
    fail(
      "OKM1120",
      `computed name ${name} is already a ${table.columns.has(name) ? "field" : "relation"} of ${table.model.name}.`,
      "Name the computed value something that is not a field or a relation. It becomes a new key on the row.",
    );
  }
  if (typeof callback !== "function") {
    fail(
      "OKM1120",
      `computed.${name} must be a function of the row.`,
      `Pass computed: { ${name}: (u) => u.posts.count() }.`,
    );
  }
  if (callback.constructor.name === "AsyncFunction") {
    fail(
      "OKM1125",
      `computed.${name} cannot be an async function.`,
      "The callback only builds an expression. Remove async, and await nothing in it.",
    );
  }
  const result = (callback as (row: unknown) => unknown)(rowView(ctx));
  const parts = isOperator(result) && operatorName(result) === "sql" ? operatorValue(result) : null;
  if (!isFragmentParts(parts)) {
    fail(
      "OKM1125",
      `computed.${name} must return an aggregate or a fragment. It returned ${describe(result)}.`,
      "Return u.posts.count(), exists, sum, avg, min, max, or a fragment built from them.",
    );
  }
  const only = parts.length === 1 ? parts[0] : undefined;
  const agg = only?.k === "i" ? ctx.tokens.get(only.n) : undefined;
  const shape = agg?.shape ?? NUMBER_SHAPE;
  return {
    name,
    agg,
    parts,
    shape,
    used: tokensIn(parts, ctx.tokens),
    column: {
      field: name,
      sql: name,
      dataType: shape.dataType,
      encode: shape.encode,
      decode: undefined,
      hidden: false,
      sensitive: false,
      guarded: false,
      writable: false,
      guardUpdate: false,
    },
  };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Promise) return "a promise";
  return typeof value === "object" ? "an object" : typeof value;
}

function tokensIn(parts: readonly FragmentPart[], tokens: ReadonlyMap<string, Agg>): Agg[] {
  const found: Agg[] = [];
  for (const part of parts) {
    if (part.k === "f") found.push(...tokensIn(part.parts, tokens));
    else if (part.k === "i") {
      const agg = tokens.get(part.n);
      if (agg !== undefined) found.push(agg);
    }
  }
  return found;
}

/** The row a callback receives. Each relation of the table is a handle with the verbs. */
function rowView(ctx: Ctx): unknown {
  const { table } = ctx;
  const handles = new Map<string, unknown>();
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        const cached = handles.get(key);
        if (cached !== undefined) return cached;
        const relation = table.relations.get(key);
        if (relation === undefined) {
          if (table.columns.has(key)) {
            fail(
              "OKM1120",
              `Field ${key} is a column of ${table.model.name}. The row in computed holds relations.`,
              `Read the column with ident("${key}") inside a fragment.`,
            );
          }
          const relations = [...table.relations.keys()];
          throwNamed(
            "OKM1120",
            key,
            relations,
            `Relation ${key} is not on ${table.model.name}. Accepted names: ${list(relations)}.`,
          );
        }
        const handle = handleFor(ctx, relation);
        handles.set(key, handle);
        return handle;
      },
    },
  );
}

function handleFor(ctx: Ctx, relation: RelationModel): unknown {
  if (relation.morph !== undefined || relation.kind !== "many") {
    fail(
      "OKM1120",
      `Relation ${relation.name} is ${relation.morph !== undefined ? "a morph relation" : "a one relation"}, so it has no aggregate.`,
      "computed counts and totals many and manyThrough relations. Read a one relation with include.",
    );
  }
  const child = indexes(ctx.schema).get(relation.table);
  if (child === undefined) {
    fail(
      "OKM1120",
      `Relation ${relation.name} names ${relation.table}, which is not in the schema.`,
    );
  }
  const label = `${ctx.table.model.name}.${relation.name}`;
  const add = (
    verb: Verb,
    shape: Shape,
    where: unknown,
    column?: ColumnModel,
    parts?: readonly FragmentPart[],
    distinct = false,
  ): unknown => {
    let group = ctx.groups.find((found) => found.relation === relation);
    if (group === undefined) {
      group = { index: ctx.groups.length, relation, child, aggs: [] };
      ctx.groups.push(group);
    }
    const bare = where === undefined && parts === undefined;
    const same = bare
      ? group.aggs.find(
          (agg) =>
            agg.verb === verb &&
            agg.column === column &&
            agg.distinct === distinct &&
            agg.where === undefined &&
            agg.parts === undefined,
        )
      : undefined;
    if (same !== undefined) return sqlExpression([{ k: "i", n: same.token }]);
    const token = `\u0000${String(ctx.tokens.size)}`;
    const agg: Agg = { group, token, verb, column, parts, distinct, where, shape, slot: "" };
    group.aggs.push(agg);
    ctx.tokens.set(token, agg);
    return sqlExpression([{ k: "i", n: token }]);
  };
  const read = (
    verb: Verb,
    options: unknown,
    accepted: readonly string[],
  ): Record<string, unknown> => readOptions(label, verb, options, accepted);
  const measure = (verb: Verb, argument: unknown, options: unknown): unknown => {
    const given = read(verb, options, ["where"]);
    const where = readWhere(child, given.where);
    if (isOperator(argument) && operatorName(argument) === "sql") {
      const parts = operatorValue(argument);
      if (!isFragmentParts(parts) || tokensIn(parts, ctx.tokens).length > 0) {
        fail(
          "OKM1125",
          `${label}.${verb} takes a fragment over the child's own fields, not another aggregate.`,
          "Use ident(field) for child fields. Combine aggregates in the computed callback.",
        );
      }
      return add(verb, NUMBER_SHAPE, where, undefined, parts);
    }
    const column = columnOf(child, label, verb, argument);
    if (verb === "sum" || verb === "avg") {
      if (!NUMERIC.test(column.dataType)) {
        fail(
          "OKM1124",
          `${verb} does not apply to ${column.dataType} column ${column.field}. sum and avg take integer, real, and numeric columns.`,
          "Use count for any type, or min and max for an ordered type.",
        );
      }
      const kind = readsAs(column);
      if (kind !== "string" && kind !== "number") {
        fail(
          "OKM1124",
          `sum and avg need a column whose value is a number or a string. ${column.field} reads as ${kind}.`,
        );
      }
      const decode = kind === "string" ? AS_TEXT : AS_NUMBER;
      return add(verb, { dataType: "numeric", encode: numberText, decode }, where, column);
    }
    if (UNORDERED.test(column.dataType)) {
      fail(
        "OKM1124",
        `${verb} does not apply to ${column.dataType} column ${column.field}. min and max need an ordered type.`,
        "Aggregate a column with an order, such as a number, text, or timestamp.",
      );
    }
    return add(
      verb,
      { dataType: column.dataType, encode: column.encode, decode: column.decode },
      where,
      column,
    );
  };
  const handle: Record<string, unknown> = {
    count(options?: unknown) {
      const given = read("count", options, ["distinct", "where"]);
      const where = readWhere(child, given.where);
      if (given.distinct === undefined) return add("count", COUNT_SHAPE, where);
      const column = columnOf(child, label, "count distinct", given.distinct);
      return add("count", COUNT_SHAPE, where, column, undefined, true);
    },
    exists(options?: unknown) {
      const given = read("exists", options, ["where"]);
      return add("exists", EXISTS_SHAPE, readWhere(child, given.where));
    },
    sum: (argument: unknown, options?: unknown) => measure("sum", argument, options),
    avg: (argument: unknown, options?: unknown) => measure("avg", argument, options),
    min: (argument: unknown, options?: unknown) => measure("min", argument, options),
    max: (argument: unknown, options?: unknown) => measure("max", argument, options),
  };
  return new Proxy(handle, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (VERBS.includes(key)) return target[key];
      throwNamed(
        "OKM1120",
        key,
        VERBS,
        `${label}.${key} is not a computed verb. Accepted verbs: ${VERB_LIST}.`,
      );
    },
  });
}

function readOptions(
  label: string,
  verb: string,
  value: unknown,
  accepted: readonly string[],
): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    fail(
      "OKM1120",
      `${label}.${verb} takes an options object.`,
      `Accepted options: ${list(accepted)}.`,
    );
  }
  for (const key of Object.keys(value)) {
    if (accepted.includes(key)) continue;
    throwNamed(
      "OKM1120",
      key,
      accepted,
      `Option ${key} is not accepted by ${label}.${verb}. Accepted options: ${list(accepted)}.`,
    );
  }
  return value;
}

function columnOf(child: Indexed, label: string, verb: string, name: unknown): ColumnModel {
  if (typeof name !== "string") {
    fail("OKM1120", `${label}.${verb} needs a field name of ${child.model.name}.`);
  }
  const column = child.columns.get(name);
  if (column === undefined) {
    throwNamed(
      "OKM1120",
      name,
      child.names,
      `Field ${name} is not on ${child.model.name}. Accepted names: ${list(child.names)}.`,
    );
  }
  if (column.hidden !== false) {
    fail(
      "OKM1120",
      `Field ${name} is hidden, so ${label}.${verb} cannot read it.`,
      "A hidden field stays out of computed. Aggregate a field that is not hidden.",
    );
  }
  return column;
}

/** Checks the names in a verb's `where` now, so an unused aggregate is refused too. */
function readWhere(child: Indexed, where: unknown): unknown {
  if (where === undefined) return undefined;
  if (isRecord(where)) {
    const keys = Object.keys(where);
    if (keys.length === 0) return undefined;
    for (const key of keys) {
      if (child.relations.has(key)) continue;
      const column = child.columns.get(key);
      if (column === undefined) {
        throwNamed(
          "OKM1120",
          key,
          child.names,
          `Field ${key} is not on ${child.model.name}. Accepted names: ${list(child.names)}.`,
        );
      }
      refuseHidden(column);
    }
  }
  return where;
}

/** Takes the entries that name a computed value out of `where`. The rest is returned. */
function splitWhere(where: unknown, names: ReadonlyMap<string, Item>, conds: Cond[]): unknown {
  if (isOperator(where)) {
    const name = operatorName(where);
    if (name === "and") {
      const kept: unknown[] = [];
      for (const part of operatorValue(where) as readonly unknown[]) {
        const rest = splitWhere(part, names, conds);
        if (rest !== undefined) kept.push(rest);
      }
      return kept.length === 0 ? undefined : tag("and", kept);
    }
    if (mentions(operatorValue(where), names)) {
      fail(
        "OKM1120",
        "A computed value cannot sit inside or() or not().",
        "Filter on it at the top level of where, beside the other fields.",
      );
    }
    return where;
  }
  if (!isRecord(where)) return where;
  let rest: Record<string, unknown> | undefined;
  for (const key of Object.keys(where)) {
    const item = names.get(key);
    const value = where[key];
    if (item === undefined) {
      (rest ??= {})[key] = value;
    } else if (value !== undefined) {
      if (item.agg === undefined) {
        fail(
          "OKM1120",
          `computed.${key} is a fragment, which is not a filter.`,
          "Filter on an aggregate, such as u.posts.count(), and use the fragment to read or order.",
        );
      }
      conds.push({ item, value, threshold: thresholdOf(item.agg, value) });
    }
  }
  return rest;
}

function mentions(value: unknown, names: ReadonlyMap<string, Item>): boolean {
  if (Array.isArray(value)) return value.some((entry) => mentions(entry, names));
  if (isOperator(value)) {
    const name = operatorName(value);
    return (
      (name === "or" || name === "and" || name === "not") && mentions(operatorValue(value), names)
    );
  }
  return isRecord(value) && Object.keys(value).some((key) => names.has(key));
}

const PASS: Threshold = { kind: "const", pass: true };
const FAIL: Threshold = { kind: "const", pass: false };

/** `count >= k` and `exists` are a row that exists. `count < k` is the absence of one. */
function thresholdOf(agg: Agg, value: unknown): Threshold | undefined {
  if (agg.verb !== "count" && agg.verb !== "exists") return undefined;
  const given = isOperator(value) ? operatorName(value) : "eq";
  const operand = isOperator(value) ? operatorValue(value) : value;
  const proof = (negate: boolean, skip: number): Threshold => ({ kind: "exists", negate, skip });
  if (agg.verb === "exists") {
    return given === "eq" && typeof operand === "boolean" ? proof(!operand, 0) : undefined;
  }
  if (typeof operand !== "number" || !Number.isInteger(operand)) return undefined;
  switch (given) {
    case "gte":
      return operand <= 0 ? PASS : proof(false, operand - 1);
    case "gt":
      return operand < 0 ? PASS : proof(false, operand);
    case "lte":
      return operand < 0 ? FAIL : proof(true, operand);
    case "lt":
      return operand <= 0 ? FAIL : proof(true, operand - 1);
    case "eq":
      return operand === 0 ? proof(true, 0) : undefined;
    default:
      return undefined;
  }
}

/** Sets each aggregate's column name in its grouped subquery, for the ones the statement reads. */
function layout(info: Computed, reading: boolean): void {
  const used = new Set<Agg>();
  if (reading) {
    for (const item of info.items) for (const agg of item.used) used.add(agg);
  }
  if (info.full) {
    for (const cond of info.conds) for (const agg of cond.item.used) used.add(agg);
  }
  for (const group of info.groups) {
    let at = 0;
    for (const agg of group.aggs) {
      agg.slot = used.has(agg) ? `c${String(at++)}` : "";
    }
  }
}

function valueRef(agg: Agg): string {
  const ref = `g${String(agg.group.index)}.${quote(agg.slot)}`;
  if (agg.verb === "count") return `coalesce(${ref}, 0)`;
  return agg.verb === "exists" ? `coalesce(${ref}, false)` : ref;
}

const statement: ReadBuild = (schema, table, sink, outputs, call, hooks) => {
  const info = call.computed as Computed;
  const reading = call.op === "find" || call.op === "one";
  const paged = reading && !info.full;
  sink.mark(`${call.op}|${table.model.name}|${paged ? "page" : "full"}|`);
  layout(info, reading);
  const named: NameHook = (name, into) => {
    const agg = info.tokens.get(name);
    if (agg === undefined) return false;
    into.mark(`:v:${String(agg.group.index)}.${agg.slot}`);
    into.text(valueRef(agg));
    return true;
  };
  if (!reading) {
    emitTotal(schema, table, sink, call, info);
    return;
  }
  if (call.include !== undefined && hooks === undefined) {
    fail("OKM1120", "An include needs the include planner.");
  }
  const alias = paged ? PAGE : "t";
  if (paged) emitMaterialized(sink, PAGE, () => emitPage(schema, table, sink, call, info));
  sink.text(paged ? " select " : "select ");
  const includes =
    hooks === undefined || call.include === undefined
      ? []
      : hooks.read(schema, table, call.include, call.all, call.limits);
  let column = 0;
  const comma = (): void => {
    if (column > 0) sink.text(", ");
  };
  for (const field of selectedColumns(table, call.select)) {
    comma();
    sink.text(projectExpr(`${alias}.${quote(field.sql)}`, field.dataType));
    sink.mark(`s:${field.field}`);
    outputs?.fields.push({ key: field.field, at: column, decode: field.decode });
    column += 1;
  }
  for (const item of info.items) {
    comma();
    emitValue(table, item, sink, alias, named);
    outputs?.fields.push({ key: item.name, at: column, decode: item.shape.decode });
    column += 1;
  }
  for (let index = 0; index < includes.length; index += 1) {
    const include = includes[index];
    if (include === undefined || hooks === undefined) continue;
    column = hooks.select(include, `i${String(index)}`, sink, outputs, column);
  }
  sink.text(" from ");
  sink.text(paged ? PAGE : `${quote(table.model.sql)} t`);
  emitGroups(schema, table, sink, info, alias, paged);
  for (let index = 0; index < includes.length; index += 1) {
    const include = includes[index];
    if (include === undefined || hooks === undefined) continue;
    hooks.join(schema, include, sink, alias, `i${String(index)}`, 0);
  }
  if (paged) {
    emitOrdered(table, call.orderBy, sink, alias);
    return;
  }
  emitWhere(
    schema,
    table,
    info.plain,
    sink,
    "t",
    0,
    false,
    joined(schema, table, call.after, info),
  );
  emitOrdered(table, call.orderBy, sink, "t", writers(table, info, named));
  emitLimit(call, sink);
};

/** `count` and `exists`: every parent needs the value, so the subqueries read the whole relation. */
function emitTotal(
  schema: QuerySchema,
  table: Indexed,
  sink: Sink,
  call: ReadCall,
  info: Computed,
): void {
  const exists = call.op === "exists";
  sink.text(exists ? "select exists(select 1 from " : "select count(*)::text from ");
  sink.text(`${quote(table.model.sql)} t`);
  emitGroups(schema, table, sink, info, "t", false);
  emitWhere(schema, table, info.plain, sink, "t", 0, false, joined(schema, table, undefined, info));
  if (exists) sink.text(")::text");
}

/** The parent page: guards, filters, thresholds, order, and the limit, before any grouped subquery. */
function emitPage(
  schema: QuerySchema,
  table: Indexed,
  sink: Sink,
  call: ReadCall,
  info: Computed,
): void {
  sink.text(`select t.* from ${quote(table.model.sql)} t`);
  const extra = pageKeyset(schema, call.after, info);
  emitWhere(schema, table, info.plain, sink, "t", 0, false, extra);
  emitOrdered(table, call.orderBy, sink, "t");
  emitLimit(call, sink);
}

function pageKeyset(
  schema: QuerySchema,
  after: Keyset | undefined,
  info: Computed,
): Keyset | undefined {
  if (after === undefined && info.conds.length === 0) return undefined;
  return (sink, alias) => {
    let wrote = false;
    if (after !== undefined) {
      after(sink, alias);
      wrote = true;
    }
    for (const cond of info.conds) {
      if (wrote) sink.text(" and ");
      wrote = true;
      emitThreshold(schema, cond, sink, alias);
    }
  };
}

/** `exists (select 1 from <children> offset k - 1 limit 1)` for a count of at least k. */
function emitThreshold(schema: QuerySchema, cond: Cond, sink: Sink, alias: string): void {
  const threshold = cond.threshold;
  const agg = cond.item.agg;
  if (threshold === undefined || agg === undefined) return;
  if (threshold.kind === "const") {
    sink.mark(`th:${String(threshold.pass)}`);
    sink.text(String(threshold.pass));
    return;
  }
  const { relation, child } = agg.group;
  sink.mark(`th:${relation.name}:${threshold.negate ? "none" : "some"}:${agg.distinct ? "d" : ""}`);
  sink.text(threshold.negate ? "not exists (select 1 from " : "exists (select 1 from ");
  emitRelationFrom(schema, relation, child, sink, alias, "a", 1);
  emitVisibility(schema, child, sink, "a", true);
  const distinct = agg.distinct ? agg.column : undefined;
  if (distinct !== undefined) sink.text(` and a.${quote(distinct.sql)} is not null`);
  if (agg.where !== undefined) emitConditions(schema, child, agg.where, sink, "a", 1, true);
  if (distinct !== undefined) sink.text(` group by a.${quote(distinct.sql)}`);
  emitSkipOne(sink, threshold.skip);
  sink.text(")");
}

/** The filters on a computed value, compared on the joined value. */
function joined(
  schema: QuerySchema,
  table: Indexed,
  after: Keyset | undefined,
  info: Computed,
): Keyset | undefined {
  if (after === undefined && info.conds.length === 0) return undefined;
  return (sink, alias) => {
    let wrote = false;
    if (after !== undefined) {
      after(sink, alias);
      wrote = true;
    }
    for (const cond of info.conds) {
      const agg = cond.item.agg;
      if (agg === undefined) continue;
      if (wrote) sink.text(" and ");
      wrote = true;
      sink.mark(`w:${cond.item.name}`);
      emitOperand(
        schema,
        table,
        cond.item.column,
        cond.value,
        sink,
        alias,
        0,
        false,
        valueRef(agg),
      );
    }
  };
}

/** Writes a computed value where `orderBy` names it. */
function writers(
  table: Indexed,
  info: Computed,
  named: NameHook,
): ReadonlyMap<string, (sink: Sink) => void> | undefined {
  if (info.orders.size === 0) return undefined;
  const found = new Map<string, (sink: Sink) => void>();
  for (const [name, item] of info.orders) {
    found.set(name, (sink) => {
      if (item.agg !== undefined) sink.text(valueRef(item.agg));
      else emitSqlSelect(table, item.parts, sink, "t", named);
    });
  }
  return found;
}

function emitOrdered(
  table: Indexed,
  orderBy: unknown,
  sink: Sink,
  alias: string,
  computed?: ReadonlyMap<string, (sink: Sink) => void>,
): void {
  emitOrder(table, orderBy, sink, alias, computed);
  const given = isRecord(orderBy) ? Object.keys(orderBy) : [];
  let first = given.length === 0;
  for (const field of table.model.primary) {
    const column = table.columns.get(field);
    if (given.includes(field) || column === undefined) continue;
    sink.text(first ? " order by " : ", ");
    first = false;
    sink.text(`${alias}.${quote(column.sql)} asc`);
  }
  sink.mark("o:pk");
}

function emitValue(table: Indexed, item: Item, sink: Sink, alias: string, named: NameHook): void {
  sink.mark(`v:${item.name}:`);
  if (item.agg !== undefined) {
    sink.text(projectExpr(valueRef(item.agg), item.shape.dataType));
  } else {
    emitSqlSelect(table, item.parts, sink, alias, named);
  }
  sink.text("::text");
}

function emitGroups(
  schema: QuerySchema,
  table: Indexed,
  sink: Sink,
  info: Computed,
  parent: string,
  paged: boolean,
): void {
  for (const group of info.groups) {
    if (group.aggs.some((agg) => agg.slot !== "")) {
      emitGroup(schema, table, sink, group, parent, paged);
    }
  }
}

/** One grouped subquery over a relation, left-joined to the parent. */
function emitGroup(
  schema: QuerySchema,
  table: Indexed,
  sink: Sink,
  group: Group,
  parent: string,
  paged: boolean,
): void {
  const { relation, child } = group;
  const through = relation.through !== undefined;
  const alias = `g${String(group.index)}`;
  sink.mark(`g:${relation.name}:${paged ? "page" : "full"}`);
  sink.text(" left join (select ");
  const keys: string[] = [];
  for (let index = 0; index < relation.local.length; index += 1) {
    const local = relation.local[index];
    const remote = relation.remote[index];
    if (local === undefined || remote === undefined) continue;
    keys.push(through ? `${paged ? PAGE : "p"}.${quote(local)}` : `a.${quote(remote)}`);
  }
  sink.text(keys.map((key, index) => `${key} as k${String(index)}`).join(", "));
  for (const agg of group.aggs) {
    if (agg.slot === "") continue;
    sink.text(", ");
    emitAggregate(schema, sink, agg);
    sink.text(` as ${quote(agg.slot)}`);
  }
  sink.text(" from ");
  if (through) {
    const source = paged ? PAGE : "p";
    sink.text(paged ? `${PAGE}, ` : `${quote(table.model.sql)} p, `);
    emitRelationFrom(schema, relation, child, sink, source, "a", 1);
    emitVisibility(schema, child, sink, "a", true);
    if (!paged) emitVisibility(schema, table, sink, "p", true);
  } else {
    sink.text(`${quote(child.model.sql)} a`);
    const inPage: Keyset | undefined = paged
      ? (into, childAlias) => {
          const columns = relation.remote.map((name) => `${childAlias}.${quote(name)}`);
          const pages = relation.local.map((name) => `${PAGE}.${quote(name)}`);
          const wrap = (parts: readonly string[]): string =>
            parts.length === 1 ? (parts[0] ?? "") : `(${parts.join(", ")})`;
          into.text(`${wrap(columns)} in (select ${pages.join(", ")} from ${PAGE})`);
        }
      : undefined;
    emitWhere(schema, child, undefined, sink, "a", 1, false, inPage);
  }
  sink.text(` group by ${keys.join(", ")}) ${alias} on `);
  sink.text(
    relation.local
      .map((name, index) => `${alias}.k${String(index)} = ${parent}.${quote(name)}`)
      .join(" and "),
  );
}

function emitAggregate(schema: QuerySchema, sink: Sink, agg: Agg): void {
  const { child } = agg.group;
  sink.mark(`a:${agg.verb}:${agg.column?.field ?? ""}:${agg.distinct ? "d" : ""}`);
  if (agg.verb === "exists") {
    emitAnyRow(sink);
  } else if (agg.verb === "count") {
    sink.text(
      agg.distinct && agg.column !== undefined
        ? `count(distinct a.${quote(agg.column.sql)})`
        : "count(*)",
    );
  } else {
    sink.text(`${agg.verb}(`);
    if (agg.parts !== undefined) emitSqlSelect(child, agg.parts, sink, "a");
    else sink.text(`a.${quote(agg.column?.sql ?? "")}`);
    sink.text(")");
  }
  if (agg.where !== undefined) {
    emitFilter(sink, () => emitConditions(schema, child, agg.where, sink, "a", 1, false));
  }
}
