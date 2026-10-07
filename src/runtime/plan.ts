/**
 * Read planning: logical shape, one Postgres statement, decode.
 *
 * A cache hit walks the call once to bind parameters. SQL is built on a miss.
 * Identifiers come from the catalog model. Values are parameters.
 */

import { OkmError, throwNamed, type QueryCode } from "../contracts/error.js";
import { runSafety, safetyInstalled, type SafetyHatch } from "./safety-hook.js";
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
export type ReadOp = "find" | "one" | "count" | "exists" | "aggregate";

/** Routing constraint chosen before execute. */
export type RouteConstraint = "auto" | "primary" | "replica";

/**
 * Tenant scope for one call.
 *
 * The value is a parameter. The cache key records `tenant` or `unscoped`, not the value.
 */
export type CallScope = { readonly value: string } | { readonly unscoped: string };

/** Writes one more `where` condition after the tenant and active-set predicates. */
export type Keyset = (sink: Sink, alias: string) => void;

/** Writes the whole statement of a read the planner does not know. */
export type ReadBuild = (
  schema: QuerySchema,
  table: Indexed,
  sink: Sink,
  outputs: Built | undefined,
  call: ReadCall,
) => void;

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
  /** The `after` cursor of a `page`. The condition joins the others with `and`. */
  readonly after?: Keyset;
  /** Set by `aggregate`. It writes the statement and the safety predicates stay in `emitWhere`. */
  readonly build?: ReadBuild;
  /** Writes the end of the statement, after `limit`. A row lock sets it. */
  readonly tail?: (sink: Sink) => void;
  /** The caller's `signal`, `timeout`, and `route`. They never enter the plan or its key. */
  readonly signal?: AbortSignal;
  readonly timeout?: number;
  /** `"primary"` or `"replica"`. Absent means the router classifies the statement. */
  readonly route?: "primary" | "replica";
  /** Set by `for()` or `unscoped()`. Absent on a schema with no tenancy. */
  readonly scope?: CallScope;
  /** Inspect lines from the tenancy object. Absent when the schema has no tenancy. */
  readonly tenancyRules?: readonly AppliedRule[];
  /** `withArchived` or `onlyArchived`. Absent means the active set. */
  readonly archive?: ArchiveView;
  /** Inspect lines for the archive set and for presets. Absent when neither applies. */
  readonly ruleLines?: readonly AppliedRule[];
};

/** How an archivable read or write chooses rows. Absent means the active set. */
export type ArchiveView = "with" | "only";

/** Scope `emitWhere` reads. Writes set it around the statement they build. */
let activeScope: CallScope | undefined;

/** Archive visibility `emitWhere` reads. Absent means the active set. */
let activeView: ArchiveView | undefined;

/**
 * Runs `fn` with a tenant scope and an archive visibility visible to {@link emitWhere}.
 *
 * Restores both, including when `fn` throws. Sync callers finish the statement
 * before the first await.
 *
 * @param scope - Tenant value or an unscoped reason
 * @param view - `with` or `only`. `undefined` is the active set
 * @param fn - Statement builder
 * @returns Whatever `fn` returns
 */
export function withRowFilters<T>(
  scope: CallScope | undefined,
  view: ArchiveView | undefined,
  fn: () => T,
): T {
  const previousScope = activeScope;
  const previousView = activeView;
  activeScope = scope;
  activeView = view;
  try {
    return fn();
  } finally {
    activeScope = previousScope;
    activeView = previousView;
  }
}

type ArchiveInspect = (
  model: TableModel | undefined,
  view: ArchiveView | undefined,
) => readonly AppliedRule[] | undefined;

let archiveInspect: ArchiveInspect | undefined;

/**
 * Installs the phrase recorder `archivable()` owns.
 *
 * A featureless schema never calls this, so the phrases stay out of startup.
 *
 * @param fn - Builds the lines for one table
 */
export function installArchiveInspect(fn: ArchiveInspect): void {
  archiveInspect = fn;
}

/**
 * Inspect lines for one archivable table.
 *
 * Absent when the trait was not installed, or the table is not archivable.
 *
 * @param model - Table model
 * @param view - `with` or `only`. `undefined` is the active set
 * @returns The lines, or `undefined`
 */
export function archiveRules(
  model: TableModel | undefined,
  view: ArchiveView | undefined,
): readonly AppliedRule[] | undefined {
  return archiveInspect?.(model, view);
}

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
  /** `file.ts:line` where the rule or the table was defined. */
  readonly source?: string;
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

const FIND_OPTIONS = [
  "include",
  "limit",
  "orderBy",
  "select",
  "route",
  "signal",
  "timeout",
  "where",
] as const;
const ONE_OPTIONS = [
  "include",
  "orderBy",
  "route",
  "select",
  "signal",
  "timeout",
  "where",
] as const;
const FILTER_OPTIONS = ["route", "signal", "timeout", "where"] as const;

/**
 * Option names `find`, `one`, `count`, and `exists` accept.
 *
 * @param op - The read
 * @returns Names in a stable order
 */
export function readOptionNames(op: ReadOp): readonly string[] {
  if (op === "find") return FIND_OPTIONS;
  if (op === "one") return ONE_OPTIONS;
  return FILTER_OPTIONS;
}

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

/**
 * Writes `<table> <alias> where <link to parent>` for a to-many relation.
 *
 * A `manyThrough` relation reads the join table and joins the related table.
 * The caller adds the related table's own predicates after it.
 */
export function emitRelationFrom(
  schema: QuerySchema,
  relation: RelationModel,
  child: Indexed,
  sink: Sink,
  parent: string,
  alias: string,
  depth: number,
): void {
  if (relation.through !== undefined) {
    const planner = { join: emitJoin, where: emitWhere, indexes, quote };
    relation.through.emit(planner, schema, relation, child, sink, parent, alias, depth);
    return;
  }
  sink.text(quote(child.model.sql));
  sink.text(" ");
  sink.text(alias);
  sink.text(" where ");
  emitJoin(sink, parent, alias, relation);
}

const SYNC_OPERATORS = ",lt,lte,gt,gte,between,inList,notIn,";
const TEXT_OPERATORS = ",startsWith,endsWith,contains,like,ilike,";

function needsOperatorSql(table: Indexed, value: unknown, key?: string): boolean {
  if (isOperator(value)) {
    const name = operatorName(value);
    if (name === "or" || name === "and") {
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
 * Runs registered safety rules before planning.
 *
 * Nothing runs until `okmodel/safety` has registered a rule. The startup
 * graph pays for the check, not for the registry.
 *
 * @param schema - Connected schema
 * @param call - The read
 */
export function verifyRead(schema: QuerySchema, call: ReadCall): void {
  if (!safetyInstalled()) return;
  const source = schema.model[call.table]?.source;
  const hatches: SafetyHatch[] = [];
  if (call.all !== undefined) hatches.push({ name: "all", reason: call.all });
  if (call.scope !== undefined && "unscoped" in call.scope) {
    hatches.push({ name: "unscoped", reason: call.scope.unscoped });
  }
  runSafety(appliedRules(call, source), hatches.length === 0 ? undefined : hatches);
}

/**
 * Binds a call: shape key and parameters, no SQL.
 *
 * @param schema - Connected schema
 * @param call - The read
 * @returns The cache key and the wire parameters
 */
export function bindCall(schema: QuerySchema, call: ReadCall, hooks?: IncludeHooks): Bound {
  verifyRead(schema, call);
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
 * Catalog rules carry `source` when the table recorded one.
 *
 * @param call - The read
 * @param source - `file.ts:line` of the table, when `table()` recorded it
 * @returns Provenance-tagged rules
 */
export function appliedRules(call: ReadCall, source?: string): readonly AppliedRule[] {
  const rules: AppliedRule[] = [];
  for (const rule of BASE_RULES) {
    if (source !== undefined && rule.contribution === "catalog") {
      rules.push({ ...rule, source });
    } else {
      rules.push(rule);
    }
  }
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
  if (call.tenancyRules !== undefined) {
    for (const rule of call.tenancyRules) rules.push(rule);
  }
  if (call.ruleLines !== undefined) {
    for (const rule of call.ruleLines) rules.push(rule);
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
  const previousScope = activeScope;
  const previousView = activeView;
  activeScope = call.scope;
  activeView = call.archive;
  try {
    emitRead(schema, call, sink, outputs, hooks);
  } finally {
    activeScope = previousScope;
    activeView = previousView;
  }
}

function emitRead(
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
  if (call.build !== undefined) {
    call.build(schema, table, sink, outputs, call);
    return;
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
  emitWhere(schema, table, call.where, sink, "t", 0, false, call.after);
  emitOrder(table, call.orderBy, sink, "t");
  emitLimit(call, sink);
  call.tail?.(sink);
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

function holdArchive(table: Indexed, sink: Sink, alias: string, appended: boolean): boolean {
  const archive = table.model.archive;
  if (archive === undefined || activeView === "with") return false;
  sink.text(appended ? " and " : " where ");
  sink.text(alias);
  sink.text(".");
  sink.text(quote(archive.at));
  sink.text(activeView === "only" ? " is not null" : " is null");
  sink.mark(activeView === "only" ? "archived|" : "active|");
  return true;
}

export function emitWhere(
  schema: QuerySchema,
  table: Indexed,
  where: unknown,
  sink: Sink,
  alias: string,
  depth: number,
  appended = false,
  extra?: Keyset,
): void {
  const held =
    schema.tenancy?.predicate({
      table: table.model.name,
      fieldSql: (field) => table.columns.get(field)?.sql,
      encode: table.columns.get(schema.tenancy?.key ?? "")?.encode,
      alias,
      appended,
      scope: activeScope,
      sink,
    }) === true;
  const archived = holdArchive(table, sink, alias, appended || held);
  let started = appended || held || archived;
  if (extra !== undefined) {
    sink.text(started ? " and (" : " where (");
    extra(sink, alias);
    sink.text(")");
    started = true;
  }
  // `and` is how presets stack on the caller's filter. Only the presets module makes one.
  for (const part of isOperator(where) && operatorName(where) === "and"
    ? (operatorValue(where) as readonly unknown[])
    : [where]) {
    if (part === undefined || !effectivePredicate(part)) continue;
    const joined = isOperator(part);
    if (!joined && !isRecord(part)) fail("OKM1121", WHERE_FIELDS);
    sink.text(started ? " and " : " where ");
    started = true;
    if (joined && operatorName(part) === "or")
      emitOr(schema, table, operatorValue(part), sink, alias, depth);
    else emitAnd(schema, table, part, sink, alias, depth);
  }
}

const WHERE_FIELDS = "where must be an object of fields. Wrap an object value with eq.";

function emitAnd(
  schema: QuerySchema,
  table: Indexed,
  where: unknown,
  sink: Sink,
  alias: string,
  depth: number,
): void {
  if (!isRecord(where)) {
    fail("OKM1121", WHERE_FIELDS);
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
  schema.tenancy?.guard(table.model.name, key, "where");
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
  wrapped = false,
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
  if (typeof value === "object") takeObject(column, value, !wrapped);
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
    emitOperand(schema, table, column, value, sink, alias, depth, true);
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
  emitOperand(schema, table, column, value, sink, alias, depth, true);
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
  emitRelationFrom(schema, relation, child, sink, alias, childAlias, depth);
  const inner = operatorValue(value);
  if (name === "every") {
    emitWhere(schema, child, undefined, sink, childAlias, depth + 1, true);
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

export function parseOrder(
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
  const accepted = readOptionNames(call.op);
  const present: Record<string, unknown> = {};
  if (call.where !== undefined) present.where = call.where;
  if (call.select !== undefined) present.select = call.select;
  if (call.orderBy !== undefined) present.orderBy = call.orderBy;
  if (call.limit !== undefined) present.limit = call.limit;
  if (call.include !== undefined) present.include = call.include;
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
  if (value === undefined || value === null) {
    fail("OKM1121", `Field ${column.field} needs a value.`);
  }
  if (typeof value === "object") takeObject(column, value);
  return value;
}

/**
 * Lets an object through only when the column's codec takes it (OKM1121).
 *
 * A column whose codec takes only scalars has no `accepts`, so every object is
 * refused for it. A bare object in a `where` is refused for every column; the
 * operators and `eq` are the explicit forms (D125).
 *
 * @param column - Target column
 * @param value - The object
 * @param bare - Whether the object sits in a `where` without `eq`
 */
export function takeObject(column: ColumnModel, value: object, bare = false): void {
  if (bare || !column.accepts?.includes({}.toString.call(value).slice(8, -1))) {
    fail("OKM1121", `Field ${column.field} rejects that object.`);
  }
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
    for (const relation of model.relations) {
      relations.set(relation.name, relation);
    }
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

/**
 * Whether `where` constrains a row.
 *
 * `undefined`, `{}`, and an object whose values are all `undefined` do not.
 * The walk goes through `and` and `not`. A relation filter and an `or` are
 * predicates. An empty `or()` branch is refused separately.
 *
 * @param where - Caller filter, or a nested operand
 * @returns `false` when the filter matches every row
 */
export function effectivePredicate(where: unknown): boolean {
  if (where === undefined) return false;
  if (isOperator(where)) {
    const name = operatorName(where);
    const value = operatorValue(where);
    if (name === "or") return true;
    if (name === "and") {
      return Array.isArray(value) && value.some((part) => effectivePredicate(part));
    }
    if (name === "not") return effectivePredicate(value);
    if (name === "has" || name === "none" || name === "every") return true;
    return true;
  }
  if (!isRecord(where)) return true;
  for (const key of Object.keys(where)) {
    if (effectivePredicate(where[key])) return true;
  }
  return false;
}

const FAIL_FIX: Partial<Record<QueryCode, string>> = {
  OKM1121: "Use eq for an object value, or has, none, or every for a relation.",
  OKM1101: "Pass limit, or call .all(reason).",
};

/**
 * Records the fix text for a code thrown from a chunk that loads on first use.
 *
 * A read does not carry the write, conflict, or include sentences. The module
 * that throws the code registers the same sentence before it can throw.
 *
 * @param code - Spec code
 * @param summary - Fix sentence `fail` attaches
 */
export function registerFailFix(code: QueryCode, summary: string): void {
  FAIL_FIX[code] = summary;
}

/**
 * Throws an {@link OkmError} for a query the planner rejects.
 *
 * @param code - Spec code
 * @param message - What failed
 */
export function fail(code: QueryCode, message: string): never {
  const summary = FAIL_FIX[code];
  throw new OkmError(code, message, summary === undefined ? undefined : { fix: { summary } });
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
