/**
 * Read planning: logical shape, one Postgres statement, decode.
 *
 * A cache hit walks the call once to bind parameters. SQL is built on a miss.
 * Identifiers come from the catalog model. Values are parameters.
 */

import { OkmError, throwNamed, type QueryCode } from "../contracts/error.js";
import { assertIdentifier } from "../contracts/catalog/identifier.js";
import {
  isOperator,
  operatorName,
  operatorValue,
  type OperatorName,
} from "../dialects/pg/operators.js";
import {
  type ColumnModel,
  type QuerySchema,
  type RelationModel,
  type TableModel,
} from "../dialects/pg/model.js";

/** A read the caller asked for. */
export type ReadOp = "find" | "one" | "count" | "exists";

/** Routing constraint chosen before execute. */
export type RouteConstraint = "auto" | "primary" | "replica";

/** One read call. `all` is the `.all(reason)` escape for an unbounded read. */
export type ReadCall = {
  readonly op: ReadOp;
  readonly table: string;
  readonly where?: unknown;
  readonly select?: unknown;
  readonly orderBy?: unknown;
  readonly limit?: unknown;
  readonly include?: unknown;
  readonly all?: string;
};

/** Where a decoded value sits. */
export type ScalarOut = {
  readonly key: string;
  readonly at: number;
  readonly decode: ((wire: string) => unknown) | undefined;
};

/** A nested include. `at` is a root column for `one` and the JSON column for `many`. */
export type IncludeOut = {
  readonly name: string;
  readonly kind: "one" | "many";
  readonly at: number;
  readonly fields: readonly ScalarOut[];
  readonly nested: readonly IncludeOut[];
};

/** Columns and includes in statement order. */
export type Outputs = {
  readonly fields: readonly ScalarOut[];
  readonly includes: readonly IncludeOut[];
};

/** Mutable outputs while a plan is compiled. */
/** Lateral include compiler. Loaded on the first include, not on a plain read. */
export type IncludeHooks = {
  read(
    schema: QuerySchema,
    table: Indexed,
    include: unknown,
    all: string | undefined,
  ): readonly ParsedInclude[];
  select(
    include: ParsedInclude,
    alias: string,
    sink: Sink,
    outputs: Built | undefined,
    column: number,
  ): number;
  join(
    schema: QuerySchema,
    include: ParsedInclude,
    sink: Sink,
    parentAlias: string,
    alias: string,
    depth: number,
  ): void;
};

export type Built = {
  fields: ScalarOut[];
  includes: IncludeOut[];
};

/** A cached physical plan. Parameters are not stored. */
export type Plan = {
  readonly fingerprint: string;
  readonly text: string;
  readonly mode: ReadOp;
  readonly outputs: Outputs;
};

/** Bound parameters plus the cache key for one call. */
export type Bound = {
  readonly key: string;
  readonly params: readonly (string | null)[];
};

/** A rule recorded for inspection. Provenance names who added it. */
export type AppliedRule = {
  readonly rule: string;
  readonly contribution: string;
  readonly provenance: string;
};

export type Indexed = {
  readonly model: TableModel;
  readonly columns: ReadonlyMap<string, ColumnModel>;
  readonly relations: ReadonlyMap<string, RelationModel>;
  readonly names: readonly string[];
};

export type Sink = {
  text(value: string): void;
  param(encoded: string): void;
  mark(token: string): void;
};

const FIND_OPTIONS = ["include", "limit", "orderBy", "select", "where"] as const;
const ONE_OPTIONS = ["include", "orderBy", "select", "where"] as const;
const FILTER_OPTIONS = ["where"] as const;

const BASE_RULES: readonly AppliedRule[] = [
  { rule: "parameterised", contribution: "planner", provenance: "planner" },
  { rule: "allowlisted", contribution: "catalog", provenance: "catalog" },
  { rule: "identifier", contribution: "catalog", provenance: "catalog" },
];

const indexesOf = new WeakMap<object, ReadonlyMap<string, Indexed>>();

/** 0.2 operator SQL. Absent until that module has been imported. */
type OperatorEmit = (
  column: ColumnModel,
  ref: string,
  name: OperatorName,
  value: unknown,
  sink: Sink,
) => void;

let operatorEmit: OperatorEmit | undefined;

/**
 * Installs the 0.2 operator compiler.
 *
 * Called when `operator-sql` loads. A second install replaces the first.
 *
 * @param emit - Compiler for containment, keys, paths, and matches
 */
export function installOperatorSql(emit: OperatorEmit): void {
  operatorEmit = emit;
}

/**
 * Reports whether planning this read has to load the 0.2 operator module first.
 *
 * Equality, comparisons, and text patterns plan without it.
 *
 * @param schema - Connected schema
 * @param call - The read
 * @returns `true` when {@link installOperatorSql} has not run and the read needs it
 */
export function readNeedsOperatorSql(schema: QuerySchema, call: ReadCall): boolean {
  if (operatorEmit !== undefined) return false;
  const table = indexes(schema).get(call.table);
  return table !== undefined && needsOperatorSql(table, call.where);
}

const SYNC_OPERATORS = ",lt,lte,gt,gte,between,inList,notIn,";
const TEXT_OPERATORS = ",startsWith,endsWith,contains,like,ilike,";

function needsOperatorSql(table: Indexed, value: unknown, key?: string): boolean {
  if (isOperator(value)) {
    const name = operatorName(value);
    if (name === "or") {
      const branches = operatorValue(value);
      return Array.isArray(branches) && branches.some((branch) => needsOperatorSql(table, branch));
    }
    if (name === "not" || name === "eq") return needsOperatorSql(table, operatorValue(value), key);
    if (TEXT_OPERATORS.includes(`,${name},`)) {
      const column = key === undefined ? undefined : table.columns.get(key);
      return column !== undefined && !isTextColumn(column.dataType);
    }
    return !SYNC_OPERATORS.includes(`,${name},`);
  }
  if (Array.isArray(value)) return value.some((item) => needsOperatorSql(table, item, key));
  if (!isRecord(value)) return false;
  for (const field of Object.keys(value)) {
    if (needsOperatorSql(table, value[field], field)) return true;
  }
  return false;
}

function isTextColumn(dataType: string): boolean {
  return (
    dataType === "text" ||
    dataType === "citext" ||
    dataType.startsWith("varchar(") ||
    dataType.startsWith("char(") ||
    dataType.startsWith("character")
  );
}

function emitLazy(
  column: ColumnModel,
  ref: string,
  name: OperatorName,
  value: unknown,
  sink: Sink,
): void {
  const emit = operatorEmit;
  if (emit === undefined) {
    fail("OKM1121", `Operator ${name} on ${column.field} is not loaded.`);
  }
  emit(column, ref, name, value, sink);
}

/**
 * Rules the read path enforces before planning.
 *
 * P21 adds the rest of the final safety verification here.
 *
 * @param rules - Rules already checked for this call
 */
export function verifyRead(rules: readonly AppliedRule[]): void {
  void rules;
}

/**
 * Binds a call: shape key and parameters, no SQL.
 *
 * @param schema - Connected schema
 * @param call - The read
 * @returns The cache key and the wire parameters
 */
export function bindCall(schema: QuerySchema, call: ReadCall, hooks?: IncludeHooks): Bound {
  const params: (string | null)[] = [];
  const marks: string[] = [];
  const sink: Sink = {
    text() {},
    param(encoded) {
      params.push(encoded);
    },
    mark(token) {
      marks.push(token);
    },
  };
  emit(schema, call, sink, undefined, hooks);
  verifyRead(BASE_RULES);
  return { key: marks.join(""), params };
}

/**
 * Compiles a call to one statement.
 *
 * @param schema - Connected schema
 * @param call - The read
 * @param key - Shape key from {@link bindCall}
 * @returns The plan
 */
export function compileCall(
  schema: QuerySchema,
  call: ReadCall,
  key: string,
  hooks?: IncludeHooks,
): Plan {
  const parts: string[] = [];
  let n = 0;
  const sink: Sink = {
    text(value) {
      parts.push(value);
    },
    param() {
      n += 1;
      parts.push(`$${String(n)}`);
    },
    mark() {},
  };
  const fields: ScalarOut[] = [];
  const includes: IncludeOut[] = [];
  emit(schema, call, sink, { fields, includes }, hooks);
  return {
    fingerprint: fingerprint(key),
    text: parts.join(""),
    mode: call.op,
    outputs: { fields, includes },
  };
}

/**
 * Decodes driver rows into plain objects.
 *
 * @param plan - Compiled plan
 * @param rows - Wire rows
 * @param table - Table name, for `not_unique`
 * @returns Rows, one row or null, a count, or a boolean
 */
export function decodeResult(
  plan: Plan,
  rows: readonly (readonly (string | null)[])[],
  table: string,
  rowOf: (outputs: Outputs, row: readonly (string | null)[]) => Record<string, unknown> = decodeRow,
): unknown {
  if (plan.mode === "count") {
    const cell = rows[0]?.[0];
    if (cell === null || cell === undefined) return 0;
    return Number(cell);
  }
  if (plan.mode === "exists") {
    const cell = rows[0]?.[0];
    return cell === "t" || cell === "true" || cell === "1";
  }
  const decoded: Record<string, unknown>[] = [];
  for (const row of rows) decoded.push(rowOf(plan.outputs, row));
  if (plan.mode === "one") {
    if (decoded.length > 1) {
      throw new OkmError(
        "not_unique",
        `one() on ${table} matched more than one row. Pass orderBy to take the first, or narrow where.`,
        { kind: "not_unique", table },
      );
    }
    return decoded[0] ?? null;
  }
  return decoded;
}

/**
 * Logical intent for inspection. Operators become plain tags.
 *
 * @param call - The read
 * @returns A JSON-safe description, without a fingerprint
 */
export function logicalIntent(call: ReadCall): {
  readonly op: ReadOp;
  readonly table: string;
  readonly where: unknown;
  readonly select: unknown;
  readonly orderBy: unknown;
  readonly limit: unknown;
  readonly include: unknown;
  readonly all: string | undefined;
} {
  return {
    op: call.op,
    table: call.table,
    where: plain(call.where),
    select: call.select,
    orderBy: call.orderBy,
    limit: call.limit,
    include: plain(call.include),
    all: call.all,
  };
}

/**
 * Rules for inspection, including the caller filter when one was passed.
 *
 * @param call - The read
 * @returns Provenance-tagged rules
 */
export function appliedRules(call: ReadCall): readonly AppliedRule[] {
  const rules: AppliedRule[] = [...BASE_RULES];
  if (call.where !== undefined) {
    rules.push({ rule: "filter", contribution: "caller", provenance: "caller" });
  }
  if (call.op === "find" || hasMany(call.include)) {
    rules.push({
      rule: "bounded",
      contribution: call.all ?? "limit",
      provenance: "caller",
    });
  }
  return rules;
}

function emit(
  schema: QuerySchema,
  call: ReadCall,
  sink: Sink,
  outputs: Built | undefined,
  hooks?: IncludeHooks,
): void {
  const table = indexes(schema).get(call.table);
  if (table === undefined) {
    throwNamed(
      "OKM1120",
      call.table,
      [...indexes(schema).keys()],
      `Table ${call.table} is not in the schema. Accepted names: ${list([...indexes(schema).keys()])}.`,
    );
  }
  rejectOptions(call);
  const selected = selectedColumns(table, call.select);
  sink.mark(`${call.op}|${call.table}|`);
  if (call.op === "count") {
    sink.text("select count(*)::text from ");
    sink.text(quote(table.model.sql));
    sink.text(" t");
    emitWhere(schema, table, call.where, sink, "t", 0);
    return;
  }
  if (call.op === "exists") {
    sink.text("select exists(select 1 from ");
    sink.text(quote(table.model.sql));
    sink.text(" t");
    emitWhere(schema, table, call.where, sink, "t", 0);
    sink.text(")::text");
    return;
  }
  sink.text("select ");
  let column = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const item = selected[index];
    if (item === undefined) continue;
    if (index > 0) sink.text(", ");
    sink.text(projectExpr(`t.${quote(item.sql)}`, item.dataType));
    sink.mark(`s:${item.field}`);
    outputs?.fields.push({ key: item.field, at: column, decode: item.decode });
    column += 1;
  }
  if (call.include !== undefined && hooks === undefined) {
    fail("OKM1120", "An include needs the include planner.");
  }
  const includes =
    hooks === undefined || call.include === undefined
      ? []
      : hooks.read(schema, table, call.include, call.all);
  if (selected.length === 0 && includes.length === 0) sink.text("1");
  for (let index = 0; index < includes.length; index += 1) {
    const include = includes[index];
    if (include === undefined) continue;
    if (hooks === undefined) continue;
    column = hooks.select(include, `i${String(index)}`, sink, outputs, column);
  }
  sink.text(" from ");
  sink.text(quote(table.model.sql));
  sink.text(" t");
  for (let index = 0; index < includes.length; index += 1) {
    const include = includes[index];
    if (include === undefined) continue;
    hooks?.join(schema, include, sink, "t", `i${String(index)}`, 0);
  }
  emitWhere(schema, table, call.where, sink, "t", 0);
  emitOrder(table, call.orderBy, sink, "t");
  emitLimit(call, sink);
}

export function emitJoin(sink: Sink, parent: string, child: string, relation: RelationModel): void {
  for (let index = 0; index < relation.local.length; index += 1) {
    const local = relation.local[index];
    const remote = relation.remote[index];
    if (local === undefined || remote === undefined) continue;
    if (index > 0) sink.text(" and ");
    sink.text(child);
    sink.text(".");
    sink.text(quote(remote));
    sink.text(" = ");
    sink.text(parent);
    sink.text(".");
    sink.text(quote(local));
  }
}

export function emitWhere(
  schema: QuerySchema,
  table: Indexed,
  where: unknown,
  sink: Sink,
  alias: string,
  depth: number,
  appended = false,
): void {
  if (where === undefined) return;
  if (isOperator(where) && operatorName(where) === "or") {
    sink.text(appended ? " and " : " where ");
    emitOr(schema, table, operatorValue(where), sink, alias, depth);
    return;
  }
  if (!isRecord(where)) {
    fail("OKM1121", "where must be an object of fields. Wrap an object value with eq.");
  }
  const keys = Object.keys(where);
  if (keys.length === 0) return;
  sink.text(appended ? " and " : " where ");
  emitAnd(schema, table, where, sink, alias, depth);
}

function emitAnd(
  schema: QuerySchema,
  table: Indexed,
  where: unknown,
  sink: Sink,
  alias: string,
  depth: number,
): void {
  if (!isRecord(where)) {
    fail("OKM1121", "where must be an object of fields. Wrap an object value with eq.");
  }
  const keys = Object.keys(where);
  let wrote = false;
  for (const key of keys) {
    const value = where[key];
    if (value === undefined) continue;
    if (wrote) sink.text(" and ");
    wrote = true;
    emitPredicate(schema, table, key, value, sink, alias, depth);
  }
  if (!wrote) sink.text("true");
}

function emitPredicate(
  schema: QuerySchema,
  table: Indexed,
  key: string,
  value: unknown,
  sink: Sink,
  alias: string,
  depth: number,
): void {
  const relation = table.relations.get(key);
  if (relation !== undefined) {
    emitRelationFilter(schema, relation, value, sink, alias, depth);
    return;
  }
  const column = table.columns.get(key);
  if (column === undefined) {
    throwNamed(
      "OKM1120",
      key,
      table.names,
      `Field ${key} is not on ${table.model.name}. Accepted names: ${list(table.names)}.`,
    );
  }
  sink.mark(`w:${key}`);
  emitOperand(schema, table, column, value, sink, alias, depth);
}

function emitOperand(
  schema: QuerySchema,
  table: Indexed,
  column: ColumnModel,
  value: unknown,
  sink: Sink,
  alias: string,
  depth: number,
): void {
  const ref = `${alias}.${quote(column.sql)}`;
  if (isOperator(value)) {
    emitOperator(
      schema,
      table,
      column,
      ref,
      operatorName(value),
      operatorValue(value),
      sink,
      alias,
      depth,
    );
    return;
  }
  if (value === null) {
    sink.mark(":null");
    sink.text(ref);
    sink.text(" is null");
    return;
  }
  if (typeof value === "object") {
    fail(
      "OKM1121",
      `Field ${column.field} received an object. Wrap it with eq. eq is the equality form for json and jsonb.`,
    );
  }
  sink.mark(":eq");
  sink.text(ref);
  sink.text(" = ");
  sink.param(column.encode(value));
}

function emitOperator(
  schema: QuerySchema,
  table: Indexed,
  column: ColumnModel | undefined,
  ref: string,
  name: OperatorName,
  value: unknown,
  sink: Sink,
  alias: string,
  depth: number,
): void {
  sink.mark(`:${name}`);
  if (name === "or") {
    emitOr(schema, table, value, sink, alias, depth);
    return;
  }
  if (column === undefined) {
    fail("OKM1121", "That operator needs a field.");
  }
  if (name === "not") {
    emitNot(schema, table, column, ref, value, sink, alias, depth);
    return;
  }
  if (name === "eq") {
    emitOperand(schema, table, column, value, sink, alias, depth);
    return;
  }
  if (name === "lt" || name === "lte" || name === "gt" || name === "gte") {
    sink.text(ref);
    sink.text(name === "lt" ? " < " : name === "lte" ? " <= " : name === "gt" ? " > " : " >= ");
    sink.param(column.encode(requireValue(column, value)));
    return;
  }
  if (name === "between") {
    if (!Array.isArray(value) || value.length !== 2) {
      fail("OKM1121", `between on ${column.field} needs two values.`);
    }
    sink.text(ref);
    sink.text(" between ");
    sink.param(column.encode(requireValue(column, value[0])));
    sink.text(" and ");
    sink.param(column.encode(requireValue(column, value[1])));
    return;
  }
  if (name === "inList" || name === "notIn") {
    emitIn(column, ref, name, value, sink);
    return;
  }
  if (TEXT_OPERATORS.includes(`,${name},`) && isTextColumn(column.dataType)) {
    if (typeof value !== "string") {
      fail("OKM1121", `${name} on ${column.field} needs a string.`);
    }
    sink.text(ref);
    if (name === "like" || name === "ilike") {
      sink.text(name === "like" ? " like " : " ilike ");
      sink.param(value);
      return;
    }
    sink.text(" like ");
    if (name !== "startsWith" && name !== "endsWith" && name !== "contains") {
      fail("OKM1121", `${name} on ${column.field} needs a string.`);
    }
    sink.param(literalPattern(value, name));
    sink.text(" escape E'\\\\'");
    return;
  }
  emitLazy(column, ref, name, value, sink);
}

function emitNot(
  schema: QuerySchema,
  table: Indexed,
  column: ColumnModel,
  ref: string,
  value: unknown,
  sink: Sink,
  alias: string,
  depth: number,
): void {
  if (value === null) {
    sink.mark(":null");
    sink.text(ref);
    sink.text(" is not null");
    return;
  }
  if (isOperator(value) && operatorName(value) === "inList") {
    const listed = operatorValue(value);
    if (Array.isArray(listed) && listed.length === 0) {
      sink.text("true");
      return;
    }
  }
  sink.text("not (");
  emitOperand(schema, table, column, value, sink, alias, depth);
  sink.text(")");
}

function emitIn(
  column: ColumnModel,
  ref: string,
  name: "inList" | "notIn",
  value: unknown,
  sink: Sink,
): void {
  if (!Array.isArray(value)) {
    fail("OKM1121", `${name} on ${column.field} needs a list.`);
  }
  sink.mark(`:${String(value.length)}`);
  if (value.length === 0) {
    sink.text(name === "inList" ? "false" : "true");
    return;
  }
  sink.text(ref);
  sink.text(name === "inList" ? " in (" : " not in (");
  for (let index = 0; index < value.length; index += 1) {
    if (index > 0) sink.text(", ");
    sink.param(column.encode(requireValue(column, value[index])));
  }
  sink.text(")");
}

function emitOr(
  schema: QuerySchema,
  table: Indexed,
  value: unknown,
  sink: Sink,
  alias: string,
  depth: number,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    sink.text("false");
    sink.mark(":0");
    return;
  }
  sink.mark(`:${String(value.length)}`);
  sink.text("(");
  for (let index = 0; index < value.length; index += 1) {
    const branch = value[index];
    if (index > 0) sink.text(" or ");
    sink.text("(");
    if (!isRecord(branch)) {
      fail("OKM1121", "or() branches must be where objects.");
    }
    let wrote = false;
    for (const key of Object.keys(branch)) {
      const item = branch[key];
      if (item === undefined) continue;
      if (wrote) sink.text(" and ");
      wrote = true;
      emitPredicate(schema, table, key, item, sink, alias, depth);
    }
    if (!wrote) sink.text("true");
    sink.text(")");
  }
  sink.text(")");
}

function emitRelationFilter(
  schema: QuerySchema,
  relation: RelationModel,
  value: unknown,
  sink: Sink,
  alias: string,
  depth: number,
): void {
  if (!isOperator(value)) {
    fail("OKM1121", `Relation ${relation.name} needs has, none, or every.`);
  }
  const name = operatorName(value);
  if (name !== "has" && name !== "none" && name !== "every") {
    fail("OKM1121", `Relation ${relation.name} needs has, none, or every.`);
  }
  const child = indexes(schema).get(relation.table);
  if (child === undefined) {
    fail(
      "OKM1120",
      `Relation ${relation.name} names ${relation.table}, which is not in the schema.`,
    );
  }
  const childAlias = `r${String(depth)}_${relation.name}`;
  sink.mark(`rel:${relation.name}:${name}`);
  if (name === "none" || name === "every") sink.text("not ");
  sink.text("exists (select 1 from ");
  sink.text(quote(child.model.sql));
  sink.text(" ");
  sink.text(childAlias);
  sink.text(" where ");
  emitJoin(sink, alias, childAlias, relation);
  const inner = operatorValue(value);
  if (name === "every") {
    sink.text(" and not (");
    emitAnd(schema, child, inner ?? {}, sink, childAlias, depth + 1);
    sink.text(")");
    sink.text(")");
    return;
  }
  emitWhere(schema, child, inner, sink, childAlias, depth + 1, true);
  sink.text(")");
}

export function emitOrder(table: Indexed, orderBy: unknown, sink: Sink, alias: string): void {
  if (orderBy === undefined) return;
  if (!isRecord(orderBy)) {
    fail("OKM1120", "orderBy must be an object of fields.");
  }
  const keys = Object.keys(orderBy);
  if (keys.length === 0) return;
  sink.text(" order by ");
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    const column = table.columns.get(key);
    if (column === undefined) {
      throwNamed(
        "OKM1120",
        key,
        table.names,
        `Field ${key} is not on ${table.model.name}. Accepted names: ${list(table.names)}.`,
      );
    }
    const parsed = parseOrder(key, orderBy[key]);
    if (index > 0) sink.text(", ");
    sink.text(alias);
    sink.text(".");
    sink.text(quote(column.sql));
    sink.text(parsed.dir === "asc" ? " asc" : " desc");
    sink.text(parsed.nulls === "first" ? " nulls first" : " nulls last");
    sink.mark(`o:${key}:${parsed.dir}:${parsed.nulls}`);
  }
}

export function emitPrimaryOrder(table: Indexed, sink: Sink, alias: string): void {
  sink.text(" order by ");
  for (let index = 0; index < table.model.primary.length; index += 1) {
    const field = table.model.primary[index];
    if (field === undefined) continue;
    const column = table.columns.get(field);
    if (column === undefined) continue;
    if (index > 0) sink.text(", ");
    sink.text(alias);
    sink.text(".");
    sink.text(quote(column.sql));
    sink.text(" asc");
  }
}

function emitLimit(call: ReadCall, sink: Sink): void {
  if (call.op === "one") {
    const ordered =
      call.orderBy !== undefined && isRecord(call.orderBy) && Object.keys(call.orderBy).length > 0;
    sink.text(ordered ? " limit 1" : " limit 2");
    sink.mark(ordered ? "one:1" : "one:2");
    return;
  }
  if (call.op !== "find") return;
  if (call.all !== undefined) {
    if (call.all.length === 0) {
      fail("OKM1101", "find() .all needs a reason.");
    }
    sink.mark(`all:${call.all}`);
    if (call.limit !== undefined) {
      const limit = readLimit(call.limit);
      sink.text(" limit ");
      sink.param(String(limit));
      sink.mark(`l:${String(limit)}`);
    }
    return;
  }
  if (call.limit === undefined) {
    fail("OKM1101", "find() needs a limit, or .all(reason) when the full set is intentional.");
  }
  const limit = readLimit(call.limit);
  sink.text(" limit ");
  sink.param(String(limit));
  sink.mark(`l:${String(limit)}`);
}

export type ParsedInclude = {
  readonly name: string;
  readonly relation: RelationModel;
  readonly where: unknown;
  readonly orderBy: unknown;
  readonly limit: number | undefined;
  readonly columns: readonly ColumnModel[];
  readonly presence: ColumnModel | undefined;
  /** Index in the projected list that is null when the related row is missing. */
  readonly anchor: number;
  readonly nested: readonly ParsedInclude[];
};

export function selectedColumns(table: Indexed, select: unknown): readonly ColumnModel[] {
  if (select === undefined) {
    const columns: ColumnModel[] = [];
    for (const column of table.model.columns) {
      if (!column.hidden) columns.push(column);
    }
    return columns;
  }
  if (!Array.isArray(select)) {
    fail("OKM1120", "select must be a list of field names.");
  }
  const columns: ColumnModel[] = [];
  for (const name of select) {
    if (typeof name !== "string") {
      fail("OKM1120", "select must be a list of field names.");
    }
    const column = table.columns.get(name);
    if (column === undefined) {
      throwNamed(
        "OKM1120",
        name,
        table.names,
        `Field ${name} is not on ${table.model.name}. Accepted names: ${list(table.names)}.`,
      );
    }
    columns.push(column);
  }
  return columns;
}

function parseOrder(
  field: string,
  value: unknown,
): { readonly dir: "asc" | "desc"; readonly nulls: "first" | "last" } {
  if (value === "asc") return { dir: "asc", nulls: "last" };
  if (value === "desc") return { dir: "desc", nulls: "first" };
  if (isRecord(value)) {
    const dir = value.dir ?? value.direction;
    if (dir !== "asc" && dir !== "desc") {
      fail("OKM1120", `orderBy ${field} must be asc or desc.`);
    }
    const nulls = value.nulls;
    if (nulls === undefined) return { dir, nulls: dir === "asc" ? "last" : "first" };
    if (nulls !== "first" && nulls !== "last") {
      fail("OKM1120", `orderBy ${field} nulls must be first or last.`);
    }
    return { dir, nulls };
  }
  fail("OKM1120", `orderBy ${field} must be asc or desc.`);
}

function rejectOptions(call: ReadCall): void {
  const record = call as unknown as Record<string, unknown>;
  const accepted =
    call.op === "find" ? FIND_OPTIONS : call.op === "one" ? ONE_OPTIONS : FILTER_OPTIONS;
  const present: Record<string, unknown> = {};
  if (call.where !== undefined) present.where = call.where;
  if (call.select !== undefined) present.select = call.select;
  if (call.orderBy !== undefined) present.orderBy = call.orderBy;
  if (call.limit !== undefined) present.limit = call.limit;
  if (call.include !== undefined) present.include = call.include;
  void record;
  rejectKeys(present, accepted, call.op);
}

export function rejectKeys(
  value: Readonly<Record<string, unknown>>,
  accepted: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (accepted.includes(key)) continue;
    throwNamed(
      "OKM1120",
      key,
      accepted,
      `Option ${key} is not accepted by ${where}. Accepted options: ${list(accepted)}.`,
    );
  }
}

export function readLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new OkmError("invalid", "limit must be an integer from 0 up.", { kind: "invalid" });
  }
  return value;
}

function requireValue(column: ColumnModel, value: unknown): unknown {
  if (value === undefined || value === null || typeof value === "object") {
    fail("OKM1121", `Field ${column.field} needs a value. Wrap an object with eq.`);
  }
  return value;
}

export function projectExpr(sql: string, dataType: string): string {
  if (dataType === "timestamptz" || dataType === "timestamp") return jsonExpr(sql, dataType);
  return sql;
}

export function jsonExpr(sql: string, dataType: string): string {
  if (dataType === "timestamptz") {
    return `to_char(${sql} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  }
  if (dataType === "timestamp") {
    return `to_char(${sql}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
  }
  return `${sql}::text`;
}

function literalPattern(value: string, mode: "startsWith" | "contains" | "endsWith"): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (char === "\\" || char === "%" || char === "_") out += "\\";
    out += char;
  }
  if (mode === "startsWith") return `${out}%`;
  if (mode === "endsWith") return `%${out}`;
  return `%${out}%`;
}

export function decodeRow(
  outputs: Outputs,
  row: readonly (string | null)[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of outputs.fields) {
    result[field.key] = cell(row[field.at], field.decode);
  }
  return result;
}

export function cell(
  value: string | null | undefined,
  decode: ((wire: string) => unknown) | undefined,
): unknown {
  if (value === null || value === undefined) return null;
  return decode === undefined ? value : decode(value);
}

export function indexes(schema: QuerySchema): ReadonlyMap<string, Indexed> {
  const cached = indexesOf.get(schema);
  if (cached !== undefined) return cached;
  const built = new Map<string, Indexed>();
  for (const model of Object.values(schema.model)) {
    assertIdentifier(model.sql, `table ${model.name}`);
    const columns = new Map<string, ColumnModel>();
    const names: string[] = [];
    for (const column of model.columns) {
      assertIdentifier(column.sql, `column ${model.name}.${column.field}`);
      columns.set(column.field, column);
      names.push(column.field);
    }
    names.sort();
    const relations = new Map<string, RelationModel>();
    for (const relation of model.relations) relations.set(relation.name, relation);
    built.set(model.name, { model, columns, relations, names });
  }
  indexesOf.set(schema, built);
  return built;
}

function fingerprint(key: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= BigInt(key.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return `Q_${hash.toString(16).padStart(16, "0")}`;
}

export function quote(name: string): string {
  let out = '"';
  for (let index = 0; index < name.length; index += 1) {
    const char = name[index] ?? "";
    out += char === '"' ? '""' : char;
  }
  return `${out}"`;
}

export function list(names: readonly string[]): string {
  return names.length === 0 ? "(none)" : names.join(", ");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isOperator(value);
}

export function fail(code: QueryCode, message: string): never {
  const fix =
    code === "OKM1121"
      ? { summary: "Use eq for an object value, or has, none, or every for a relation." }
      : code === "OKM1101"
        ? { summary: "Pass limit, or call .all(reason)." }
        : code === "OKM1102"
          ? { summary: "Pass where, or call .all(reason) to match every row." }
          : code === "OKM1104"
            ? { summary: "Set on to the columns of a unique constraint or the primary key." }
            : code === "OKM1105"
              ? { summary: "Pass limit on the include, or call .all(reason)." }
              : code === "OKM1190"
                ? { summary: "Remove the guarded field. Input cannot set it." }
                : undefined;
  throw new OkmError(code, message, fix === undefined ? undefined : { fix });
}

function plain(value: unknown): unknown {
  if (isOperator(value)) {
    return { op: operatorName(value), value: plain(operatorValue(value)) };
  }
  if (Array.isArray(value)) return value.map((item) => plain(item));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = plain((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

function hasMany(include: unknown): boolean {
  if (!isRecord(include)) return false;
  return Object.keys(include).length > 0;
}
