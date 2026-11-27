/**
 * Prints a view body as parameter-free SQL.
 *
 * This is the query API (`find`, `aggregate`, `sql`), not a second builder.
 * The statement has no tenant predicate and no default limit. `orderBy`
 * without `limit` is refused. The module is loaded with `okmodel/view`, not
 * with a featureless app.
 */

import { OkmError } from "../../../contracts/error.js";
import type { Names } from "../casing.js";
import { ColumnBuilder, formatType, type ColumnState } from "../column.js";
import { EXPR_AS, isExpr, nodeOf, type Node } from "../expr/index.js";
import { printNode } from "../expr/print.js";
import { isOperator, operatorName, operatorValue } from "../operators.js";
import { toOneJoinSql } from "../path-sql.js";
import { quoteLiteral } from "../quote.js";
import type { AnyTable } from "../table.js";
import { quoteIdent } from "../ddl.js";

/** One column of the printed view. */
export type CompiledColumn = {
  readonly name: string;
  readonly field: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly strict: boolean;
  readonly encode?: ((value: unknown) => string) | undefined;
  readonly decode?: ((wire: string) => unknown) | undefined;
};

/** SQL and the columns a view stores. */
export type CompiledView = {
  readonly query: string;
  readonly columns: readonly CompiledColumn[];
};

/** A `q.sql` column. `type` is a column builder such as `t.text()`. */
export type SqlColumnInput = {
  readonly name: string;
  readonly type: object;
};

/** What the view callback returns. */
export type CapturedBody =
  | {
      readonly op: "find";
      readonly source: object;
      readonly options: Readonly<Record<string, unknown>>;
    }
  | {
      readonly op: "aggregate";
      readonly source: object;
      readonly options: Readonly<Record<string, unknown>>;
    }
  | { readonly op: "sql"; readonly columns: readonly SqlColumnInput[]; readonly query: string };

type Join = { readonly relation: string; readonly alias: string; readonly sql: string };

type ColumnRef = {
  readonly sql: string;
  readonly alias: string;
  readonly state: ColumnState<unknown> | undefined;
};

/**
 * Prints one captured body.
 *
 * @param name - View name, for errors
 * @param body - What the callback returned
 * @param sources - Tables and views the callback may read
 * @param names - Schema casing
 * @param renderSource - Compiles a view the body reads
 * @param tenant - Schema tenancy, when the view is compiled inside `schema()`
 * @returns The query and its output columns
 */
export function compileView(
  name: string,
  body: CapturedBody,
  sources: readonly object[],
  names: Names,
  renderSource: (source: object) => CompiledView,
  tenant?: ViewTenant,
): CompiledView {
  const previous = viewTenant;
  viewTenant = tenant;
  try {
    if (body.op === "sql") return compileSql(name, body);
    if (body.op === "aggregate") return compileAggregate(name, body, sources, names, renderSource);
    return compileFind(name, body, sources, names, renderSource);
  } finally {
    viewTenant = previous;
  }
}

/**
 * The tenant column `schema({ tenancy })` adds to a tenant table.
 *
 * The view callback holds the table from `tables`, which is the table before
 * that rewrite. The compiler adds the column when the body names the key.
 */
export type ViewTenant = {
  readonly key: string;
  readonly column: () => object;
  readonly isPath?: (table: string) => boolean;
};

/** Set for the view being compiled, including a view it reads. */
let viewTenant: ViewTenant | undefined;

function compileSql(
  name: string,
  body: Extract<CapturedBody, { readonly op: "sql" }>,
): CompiledView {
  const query = body.query.trim().replace(/;\s*$/, "");
  if (query.length === 0) {
    refuse(name, "q.sql needs a query.");
  }
  if (body.columns.length === 0) refuse(name, "q.sql needs a column.");
  const columns = body.columns.map((column) => {
    const builder = column.type;
    if (!(builder instanceof ColumnBuilder)) {
      refuse(name, `Column ${column.name} needs a column builder, such as t.text().`);
    }
    const state = builder.state;
    const nullable = state.nullable === true;
    return {
      name: column.name,
      field: viewColumnField(column.name),
      dataType: catalogType(state.baseType, state.dims),
      nullable,
      strict: !nullable,
      encode: state.encode as (value: unknown) => string,
      decode: state.decode as ((wire: string) => unknown) | undefined,
    };
  });
  return { query, columns };
}

function compileFind(
  name: string,
  body: Extract<CapturedBody, { readonly op: "find" }>,
  sources: readonly object[],
  names: Names,
  renderSource: (source: object) => CompiledView,
): CompiledView {
  const options = body.options;
  refuseUnknown(name, options, ["select", "where", "orderBy", "limit", "distinct"]);
  const from = openFrom(name, body.source, sources, names, renderSource);
  const joins: Join[] = [];
  const columns = selectColumns(name, from, options.select, names, joins, sources);
  const where = options.where;
  const whereSql =
    where === undefined ? "" : ` where ${predicate(name, from, where, names, joins, sources)}`;
  const order = options.orderBy;
  const limit = options.limit;
  if (order !== undefined && limit === undefined) {
    refuse(name, "orderBy needs a limit.");
  }
  let orderSql = "";
  if (order !== undefined)
    orderSql = ` order by ${orderList(name, from, order, names, joins, sources)}`;
  let limitSql = "";
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) {
      refuse(name, "limit must be a non-negative integer.");
    }
    limitSql = ` limit ${String(limit)}`;
  }
  const distinct = options.distinct === true ? "distinct " : "";
  const listed = columns
    .map((column) => `${column.ref} as ${quoteIdent(column.out.name)}`)
    .join(", ");
  const joinSql = joins.map((join) => ` ${join.sql}`).join("");
  const query = `select ${distinct}${listed} from ${from.from}${joinSql}${whereSql}${orderSql}${limitSql}`;
  return { query, columns: columns.map((column) => column.out) };
}

function compileAggregate(
  name: string,
  body: Extract<CapturedBody, { readonly op: "aggregate" }>,
  sources: readonly object[],
  names: Names,
  renderSource: (source: object) => CompiledView,
): CompiledView {
  const options = body.options;
  refuseUnknown(name, options, ["select", "where", "groupBy", "orderBy", "limit"]);
  const from = openFrom(name, body.source, sources, names, renderSource);
  const joins: Join[] = [];
  const groups = groupColumns(name, from, options.groupBy, names, joins, sources);
  const selected = aggregateSelect(name, from, options.select, names, joins, sources);
  if (groups.length === 0 && selected.length === 0) {
    refuse(name, "aggregate() needs groupBy or select.");
  }
  if (options.orderBy !== undefined && options.limit === undefined) {
    refuse(name, "orderBy needs a limit.");
  }
  const where = options.where;
  const whereSql =
    where === undefined ? "" : ` where ${predicate(name, from, where, names, joins, sources)}`;
  const parts = [
    ...groups.map((column) => `${column.ref} as ${quoteIdent(column.out.name)}`),
    ...selected.map((column) => `${column.expr} as ${quoteIdent(column.out.name)}`),
  ];
  const groupSql =
    groups.length === 0 ? "" : ` group by ${groups.map((column) => column.ref).join(", ")}`;
  let orderSql = "";
  if (options.orderBy !== undefined) {
    orderSql = ` order by ${orderList(name, from, options.orderBy, names, joins, sources)}`;
  }
  const limit =
    typeof options.limit === "number" && Number.isInteger(options.limit)
      ? ` limit ${String(options.limit)}`
      : "";
  const query = `select ${parts.join(", ")} from ${from.from}${joins.map((join) => ` ${join.sql}`).join("")}${whereSql}${groupSql}${orderSql}${limit}`;
  return {
    query,
    columns: [...groups.map((column) => column.out), ...selected.map((column) => column.out)],
  };
}

type From = {
  readonly table: AnyTable | undefined;
  readonly from: string;
  readonly columns: ReadonlyMap<string, ColumnRef>;
  readonly output: readonly CompiledColumn[];
};

type Picked = { readonly ref: string; readonly out: CompiledColumn };

function openFrom(
  name: string,
  source: object,
  sources: readonly object[],
  names: Names,
  renderSource: (source: object) => CompiledView,
): From {
  if (!sources.includes(source)) {
    refuse(name, "The query reads a table that is not in tables.");
  }
  if (isTable(source)) {
    const sql = names.table(source);
    const columns = new Map<string, ColumnRef>();
    const output: CompiledColumn[] = [];
    for (const [field, builder] of Object.entries(source.columns)) {
      if (!(builder instanceof ColumnBuilder)) continue;
      const state = builder.state;
      const columnName = names.column(source, field);
      const ref: ColumnRef = { sql: columnName, alias: "t", state };
      columns.set(field, ref);
      if (state.hidden === true) continue;
      output.push(columnOut(field, columnName, state));
    }
    appendTenant(source, columns, output, names, "t", false);
    return { table: source, from: `${quoteIdent(sql)} t`, columns, output };
  }
  const compiled = renderSource(source);
  const record = source as { readonly name?: string };
  const sql = typeof record.name === "string" ? record.name : "";
  const columns = new Map<string, ColumnRef>();
  for (const column of compiled.columns) {
    columns.set(column.field, {
      sql: column.name,
      alias: "t",
      state: undefined,
    });
  }
  return {
    table: undefined,
    from: `${quoteIdent(sql)} t`,
    columns,
    output: compiled.columns,
  };
}

function selectColumns(
  name: string,
  from: From,
  select: unknown,
  names: Names,
  joins: Join[],
  sources: readonly object[],
): readonly Picked[] {
  if (select === undefined) {
    return from.output.map((column) => ({
      ref: `t.${quoteIdent(column.name)}`,
      out: column,
    }));
  }
  if (!Array.isArray(select) || select.length === 0) {
    refuse(name, "select must be a list of fields.");
  }
  return select.map((entry) => pick(name, from, entry, names, joins, sources));
}

function pick(
  name: string,
  from: From,
  entry: unknown,
  names: Names,
  joins: Join[],
  sources: readonly object[],
): Picked {
  if (typeof entry === "string") {
    const ref = resolvePath(name, from, entry, names, joins, sources);
    const out = ref.out;
    return { ref: ref.ref, out };
  }
  if (isExpr(entry)) {
    const alias = (entry as { readonly [EXPR_AS]?: string })[EXPR_AS];
    if (typeof alias !== "string") refuse(name, "An expression in select needs .as(name).");
    const node = nodeOf(entry);
    const sql = printNode(
      node,
      (key) => columnSql(name, from, key, names, joins, sources),
      () => refuse(name, "A where object inside an expression needs q.sql."),
    );
    const typed = exprColumn(alias, node, from);
    return { ref: sql, out: typed };
  }
  refuse(name, "select takes a field, a relation path, or an expression with .as().");
}

function groupColumns(
  name: string,
  from: From,
  groupBy: unknown,
  names: Names,
  joins: Join[],
  sources: readonly object[],
): readonly Picked[] {
  if (groupBy === undefined) return [];
  if (!Array.isArray(groupBy)) refuse(name, "groupBy must be a list of fields.");
  return groupBy.map((entry) => {
    if (typeof entry !== "string") refuse(name, "groupBy takes field names.");
    const resolved = resolvePath(name, from, entry, names, joins, sources);
    return { ref: resolved.ref, out: resolved.out };
  });
}

function aggregateSelect(
  name: string,
  from: From,
  select: unknown,
  names: Names,
  joins: Join[],
  sources: readonly object[],
): readonly { readonly expr: string; readonly out: CompiledColumn }[] {
  if (select === undefined) return [];
  if (typeof select !== "object" || select === null || Array.isArray(select)) {
    refuse(name, "aggregate select must be an object of named aggregates.");
  }
  const out: { readonly expr: string; readonly out: CompiledColumn }[] = [];
  for (const [key, entry] of Object.entries(select as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      refuse(name, `select ${key} needs one of count, sum, avg, min, or max.`);
    }
    const keys = Object.keys(entry);
    const fn = keys[0];
    if (keys.length !== 1 || fn === undefined) {
      refuse(name, `select ${key} needs exactly one aggregate.`);
    }
    const arg = (entry as Record<string, unknown>)[fn];
    const sqlName = names.name(key);
    if (fn === "count" && arg === true) {
      out.push({
        expr: "count(*)",
        out: {
          name: sqlName,
          field: viewColumnField(sqlName),
          dataType: "bigint",
          nullable: false,
          strict: true,
          decode: decodeCount,
        },
      });
      continue;
    }
    if (fn !== "sum" && fn !== "avg" && fn !== "min" && fn !== "max" && fn !== "count") {
      refuse(name, `select ${key} cannot use ${fn}. Use count, sum, avg, min, or max, or q.sql.`);
    }
    if (typeof arg !== "string") refuse(name, `select ${key} needs a field.`);
    const column = resolvePath(name, from, arg, names, joins, sources);
    const call = fn === "count" ? `count(${column.ref})` : `${fn}(${column.ref})`;
    const numeric = fn === "sum" || fn === "avg";
    out.push({
      expr: call,
      out: numeric
        ? {
            name: sqlName,
            field: viewColumnField(sqlName),
            dataType: "numeric",
            nullable: true,
            strict: false,
          }
        : {
            ...column.out,
            name: sqlName,
            field: viewColumnField(sqlName),
            nullable: fn === "count" ? false : column.out.nullable,
            strict: fn === "count",
            ...(fn === "count" ? { dataType: "bigint", decode: decodeCount } : {}),
          },
    });
  }
  return out;
}

function orderList(
  name: string,
  from: From,
  orderBy: unknown,
  names: Names,
  joins: Join[],
  sources: readonly object[],
): string {
  if (typeof orderBy !== "object" || orderBy === null || Array.isArray(orderBy)) {
    refuse(name, "orderBy must be an object of fields.");
  }
  const parts: string[] = [];
  for (const [key, direction] of Object.entries(orderBy as Record<string, unknown>)) {
    if (isRelationKey(from, key) && isPlain(direction)) {
      const joined = joinRelation(name, from, key, names, joins, sources);
      parts.push(orderList(name, joined, direction, names, joins, sources));
      continue;
    }
    if (direction !== "asc" && direction !== "desc")
      refuse(name, `orderBy ${key} must be asc or desc.`);
    const column = resolvePath(name, from, key, names, joins, sources);
    parts.push(`${column.ref} ${direction}`);
  }
  if (parts.length === 0) refuse(name, "orderBy needs a field.");
  return parts.join(", ");
}

function predicate(
  name: string,
  from: From,
  where: unknown,
  names: Names,
  joins: Join[],
  sources: readonly object[],
): string {
  if (Array.isArray(where)) {
    if (where.length === 0) return "true";
    return where
      .map((part) => `(${predicate(name, from, part, names, joins, sources)})`)
      .join(" and ");
  }
  if (isExpr(where)) {
    return printNode(
      nodeOf(where),
      (key) => columnSql(name, from, key, names, joins, sources),
      (part) => predicate(name, from, part, names, joins, sources),
    );
  }
  if (isOperator(where) && (operatorName(where) === "and" || operatorName(where) === "or")) {
    const op = operatorName(where) === "and" ? " and " : " or ";
    const branches = operatorValue(where);
    if (!Array.isArray(branches) || branches.length === 0)
      refuse(name, "and() and or() need a list.");
    return branches
      .map((part) => `(${predicate(name, from, part, names, joins, sources)})`)
      .join(op);
  }
  if (typeof where !== "object" || where === null) refuse(name, "where must be an object.");
  const parts: string[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (isRelationKey(from, key) && isPlain(value) && !isOperator(value) && !isExpr(value)) {
      const joined = joinRelation(name, from, key, names, joins, sources);
      parts.push(predicate(name, joined, value, names, joins, sources));
      continue;
    }
    const column = resolvePath(name, from, key, names, joins, sources);
    parts.push(compare(name, column.ref, value, from, names, joins, sources));
  }
  if (parts.length === 0) return "true";
  return parts.join(" and ");
}

function compare(
  name: string,
  ref: string,
  value: unknown,
  from: From,
  names: Names,
  joins: Join[],
  sources: readonly object[],
): string {
  if (isExpr(value)) {
    const sql = printNode(
      nodeOf(value),
      (key) => columnSql(name, from, key, names, joins, sources),
      () => refuse(name, "A where object inside an expression needs q.sql."),
    );
    return `${ref} = ${sql}`;
  }
  if (!isOperator(value)) {
    if (value === null) return `${ref} is null`;
    return `${ref} = ${literal(name, value)}`;
  }
  const op = operatorName(value);
  const inner = operatorValue(value);
  if (op === "eq") return compare(name, ref, inner, from, names, joins, sources);
  if (op === "lt" || op === "lte" || op === "gt" || op === "gte") {
    const sign = op === "lt" ? "<" : op === "lte" ? "<=" : op === "gt" ? ">" : ">=";
    return `${ref} ${sign} ${operand(name, inner, from, names, joins, sources)}`;
  }
  if (op === "inList" || op === "notIn") {
    if (!Array.isArray(inner) || inner.length === 0) refuse(name, `${op} needs a list of values.`);
    const list = inner.map((item) => operand(name, item, from, names, joins, sources)).join(", ");
    return `${ref} ${op === "notIn" ? "not in" : "in"} (${list})`;
  }
  if (op === "not") {
    if (inner === null) return `${ref} is not null`;
    return `not (${compare(name, ref, inner, from, names, joins, sources)})`;
  }
  if (op === "like" || op === "ilike") {
    return `${ref} ${op === "ilike" ? "ilike" : "like"} ${operand(name, inner, from, names, joins, sources)}`;
  }
  if (op === "startsWith" || op === "endsWith" || op === "contains") {
    if (typeof inner !== "string") refuse(name, `${op} needs text.`);
    const pattern =
      op === "startsWith" ? `${inner}%` : op === "endsWith" ? `%${inner}` : `%${inner}%`;
    return `${ref} like ${quoteLiteral(pattern)}`;
  }
  refuse(name, `where cannot print ${op}. Use q.sql for this filter.`);
}

function operand(
  name: string,
  value: unknown,
  from: From,
  names: Names,
  joins: Join[],
  sources: readonly object[],
): string {
  if (isExpr(value)) {
    return printNode(
      nodeOf(value),
      (key) => columnSql(name, from, key, names, joins, sources),
      () => refuse(name, "A where object inside an expression needs q.sql."),
    );
  }
  return literal(name, value);
}

function resolvePath(
  name: string,
  from: From,
  path: string,
  names: Names,
  joins: Join[],
  sources: readonly object[],
): Picked {
  const dot = path.indexOf(".");
  if (dot < 0) {
    const column = from.columns.get(path);
    if (column === undefined) refuse(name, `Column ${path} is not on this table.`);
    const out =
      from.output.find((item) => item.field === path || item.name === column.sql) ??
      (column.state !== undefined
        ? columnOut(path, column.sql, column.state)
        : {
            name: column.sql,
            field: path,
            dataType: "text",
            nullable: true,
            strict: false,
          });
    return { ref: `${column.alias}.${quoteIdent(column.sql)}`, out };
  }
  const relation = path.slice(0, dot);
  const field = path.slice(dot + 1);
  if (field.includes(".")) refuse(name, `Path ${path} is deeper than one relation.`);
  const joined = joinRelation(name, from, relation, names, joins, sources);
  return resolvePath(name, joined, field, names, joins, sources);
}

function joinRelation(
  view: string,
  from: From,
  relation: string,
  names: Names,
  joins: Join[],
  sources: readonly object[],
): From {
  const table = from.table;
  if (table === undefined)
    refuse(view, `View ${view} cannot follow ${relation}. The source is not a table.`);
  const relations = (
    table.options as { readonly relations?: Readonly<Record<string, RelationCall>> } | undefined
  )?.relations;
  const call = relations?.[relation];
  if (call === undefined || call.kind !== "one") {
    refuse(view, `${relation} is not a to-one relation of ${table.name}.`);
  }
  const target = sources.find(
    (item): item is AnyTable => isTable(item) && item.name === call.table,
  );
  if (target === undefined) {
    refuse(view, `Add ${call.table} to tables before reading ${relation}.`);
  }
  const existing = joins.find((join) => join.relation === relation);
  const alias = existing === undefined ? `j${String(joins.length + 1)}` : existing.alias;
  if (existing === undefined) {
    const fk = foreignKey(table, call, names);
    const targetKey = referencedColumn(table, call, names);
    joins.push({
      relation,
      alias,
      sql: toOneJoinSql(quoteIdent(names.table(target)), alias, "t", [
        [quoteIdent(fk), quoteIdent(targetKey)],
      ]),
    });
  }
  const columns = new Map<string, ColumnRef>();
  const output: CompiledColumn[] = [];
  for (const [field, builder] of Object.entries(target.columns)) {
    if (!(builder instanceof ColumnBuilder)) continue;
    const state = builder.state;
    const columnName = names.column(target, field);
    columns.set(field, { sql: columnName, alias, state });
    if (state.hidden === true) continue;
    output.push({ ...columnOut(field, columnName, state), nullable: true, strict: false });
  }
  appendTenant(target, columns, output, names, alias, true);
  return { table: target, from: from.from, columns, output };
}

/**
 * Adds the schema tenant column when the table does not already declare it.
 *
 * A global table and a path table do not have the column. A left join leaves
 * it nullable, the same as every other joined column.
 *
 * @param table - Source table
 * @param columns - Columns the body can name
 * @param output - Columns a bare `find` selects
 * @param names - Schema casing
 * @param alias - SQL alias of this source
 * @param left - The source was reached through a left join
 */
function appendTenant(
  table: AnyTable,
  columns: Map<string, ColumnRef>,
  output: CompiledColumn[],
  names: Names,
  alias: string,
  left: boolean,
): void {
  const tenant = viewTenant;
  if (tenant === undefined || columns.has(tenant.key)) return;
  if (tenant.isPath?.(table.name) === true) return;
  const mark = (table.options as { readonly tenancy?: { readonly kind?: unknown } } | undefined)
    ?.tenancy;
  if (mark?.kind === "global") return;
  const built = tenant.column();
  if (!(built instanceof ColumnBuilder)) return;
  const sql = names.column(table, tenant.key);
  columns.set(tenant.key, { sql, alias, state: built.state });
  const out = columnOut(tenant.key, sql, built.state);
  output.push(left ? { ...out, nullable: true, strict: false } : out);
}

function columnSql(
  name: string,
  from: From,
  key: string,
  names: Names,
  joins: Join[],
  sources: readonly object[],
): string {
  return resolvePath(name, from, key, names, joins, sources).ref;
}

function columnOut(field: string, sql: string, state: ColumnState<unknown>): CompiledColumn {
  const nullable = state.nullable === true;
  return {
    name: sql,
    field,
    dataType: catalogType(state.baseType, state.dims),
    nullable,
    strict: !nullable,
    encode: state.encode as (value: unknown) => string,
    decode: state.decode as ((wire: string) => unknown) | undefined,
  };
}

function exprColumn(alias: string, node: Node, from: From): CompiledColumn {
  const typed = exprType(node, from);
  return {
    name: alias,
    field: viewColumnField(alias),
    dataType: typed.dataType,
    nullable: typed.nullable,
    strict: !typed.nullable,
  };
}

function exprType(
  node: Node,
  from: From,
): { readonly dataType: string; readonly nullable: boolean } {
  if (node.k === "col") {
    const column = from.columns.get(node.name);
    if (column?.state !== undefined) {
      return {
        dataType: catalogType(column.state.baseType, column.state.dims),
        nullable: column.state.nullable === true,
      };
    }
  }
  if (node.k === "fn") {
    if (node.name === "length") return { dataType: "integer", nullable: false };
    if (node.name === "to_tsvector" || node.name === "setweight") {
      return { dataType: "tsvector", nullable: false };
    }
    return { dataType: "text", nullable: false };
  }
  if (node.k === "cast") {
    const type =
      node.to === "double precision"
        ? "double precision"
        : node.to === "timestamptz"
          ? "timestamp with time zone"
          : node.to;
    return { dataType: type, nullable: false };
  }
  if (node.k === "op") return { dataType: "numeric", nullable: false };
  if (node.k === "concat") return { dataType: "text", nullable: false };
  return { dataType: "text", nullable: true };
}

function foreignKey(table: AnyTable, call: RelationCall, names: Names): string {
  if (call.field !== undefined) return names.column(table, call.field);
  for (const [field, builder] of Object.entries(table.columns)) {
    if (!(builder instanceof ColumnBuilder)) continue;
    if (builder.state.references?.table === call.table) return names.column(table, field);
  }
  throw new OkmError("OKM1120", `Relation ${call.table} needs a references() column.`, {
    fix: { summary: "Point a column at that table with references(), or pass the field to one()." },
  });
}

function referencedColumn(table: AnyTable, call: RelationCall, names: Names): string {
  for (const builder of Object.values(table.columns)) {
    if (!(builder instanceof ColumnBuilder)) continue;
    const ref = builder.state.references;
    if (ref?.table !== call.table) continue;
    const target = ref.columns?.[0];
    return target ?? "id";
  }
  const field = call.field;
  if (field !== undefined) {
    const builder = table.columns[field];
    if (builder instanceof ColumnBuilder) {
      return builder.state.references?.columns?.[0] ?? "id";
    }
  }
  return names.name("id");
}

type RelationCall = { readonly kind: string; readonly table: string; readonly field?: string };

function isRelationKey(from: From, key: string): boolean {
  const table = from.table;
  if (table === undefined || key.includes(".")) return false;
  const relations = (
    table.options as { readonly relations?: Readonly<Record<string, RelationCall>> } | undefined
  )?.relations;
  return relations?.[key]?.kind === "one";
}

function isTable(value: object): value is AnyTable {
  return "columns" in value && "name" in value && !("contribute" in value);
}

function literal(name: string, value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    if (value.includes("\0"))
      refuse(name, "A value with a NUL character cannot be written into SQL.");
    return quoteLiteral(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint" || (typeof value === "number" && Number.isFinite(value))) {
    const text = String(value);
    return text.startsWith("-") ? `(${text})` : text;
  }
  refuse(name, "where can print a string, a number, a boolean, or null. Use q.sql for this value.");
}

function decodeCount(wire: string): number {
  const value = Number(wire);
  if (!Number.isFinite(value)) {
    throw new OkmError("OKM1121", `count ${wire} is not a number.`, {
      fix: { summary: "The database returned a count this client cannot decode." },
    });
  }
  return value;
}

function refuseUnknown(
  name: string,
  options: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key))
      refuse(name, `Option ${key} is not available on a view query. Use q.sql.`);
  }
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catalogType(baseType: string, dims: number): string {
  const formatted = formatType(baseType, dims);
  const varchar = /^varchar\((\d+)\)(.*)$/.exec(formatted);
  if (varchar !== null) return `character varying(${varchar[1] ?? ""})${varchar[2] ?? ""}`;
  return formatted;
}

/**
 * Field name a `q.sql` column and a matview index callback share.
 *
 * @param name - SQL column name
 * @returns The camelCase field
 */
export function viewColumnField(name: string): string {
  return camel(name);
}

function camel(name: string): string {
  let out = "";
  let upper = false;
  for (const char of name) {
    if (char === "_") {
      upper = out.length > 0;
      continue;
    }
    out += upper ? char.toUpperCase() : char;
    upper = false;
  }
  return out;
}

function refuse(name: string, message: string): never {
  throw new OkmError("OKM1120", `View ${name}: ${message}`, {
    fix: { summary: "Change the query, or use q.sql for SQL this compiler does not print." },
  });
}
