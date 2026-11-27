/**
 * Dotted keys in `where`, `select`, `orderBy`, and `groupBy`.
 *
 * Loaded on the first key that contains `.`. A composite field prints
 * `(alias."column")."field"`. A to-one path is the same `"relation.column"`
 * shape the view compiler uses, and the join keeps the related table's tenant
 * and archive predicates. Update stays in the writer.
 */

import { throwNamed } from "../contracts/error.js";
import { compositeMark } from "../dialects/pg/column.js";
import type { CompositeFieldCodec, CompositeMark } from "../dialects/pg/composite-mark.js";
import type { ColumnModel, QuerySchema, RelationModel } from "../dialects/pg/model.js";
import { compositeAccess, toOneJoinSql } from "../dialects/pg/path-sql.js";
import { isOperator, operatorName, operatorValue } from "../dialects/pg/operators.js";
import {
  emitOperand,
  emitWhere,
  fail,
  indexes,
  installPaths,
  isRecord,
  list,
  parseOrder,
  projectExpr,
  quote,
  refuseHidden,
  type Indexed,
  type ReadCall,
  type Sink,
} from "./plan.js";

type Join = {
  readonly name: string;
  readonly alias: string;
  readonly child: Indexed;
  readonly relation: RelationModel;
};

type Hit = {
  readonly column: ColumnModel;
  readonly sql: (alias: string) => string;
};

type Walked = {
  readonly names: readonly string[];
  readonly codec: CompositeFieldCodec;
  readonly nullable: boolean;
};

let joins: Join[] = [];
const cache = new Map<string, Hit>();

/**
 * Records the joins a dotted read needs, before the statement is written.
 *
 * @param schema - Connected schema
 * @param call - The read, including `groupBy` when the call is an aggregate
 */
function prepare(schema: QuerySchema, call: ReadCall): void {
  joins = [];
  cache.clear();
  const table = indexes(schema).get(call.table);
  if (table === undefined) return;
  walk(schema, table, call.where, "t");
  walkList(schema, table, call.select);
  walk(schema, table, call.orderBy, "t");
  walkList(schema, table, call.groupBy);
}

/** Drops the joins from the previous read. */
function end(): void {
  joins = [];
  cache.clear();
}

/**
 * Writes one dotted predicate.
 *
 * @param schema - Connected schema
 * @param table - The table the key is relative to
 * @param key - The dotted key
 * @param value - The operand
 * @param sink - Statement under construction
 * @param alias - Alias of `table`
 * @param depth - Relation-filter depth
 */
function where(
  schema: QuerySchema,
  table: Indexed,
  key: string,
  value: unknown,
  sink: Sink,
  alias: string,
  depth: number,
): void {
  const hit = resolve(schema, table, key, alias);
  sink.mark(`w:${key}`);
  emitOperand(schema, table, hit.column, value, sink, alias, depth, false, hit.sql(alias));
}

/**
 * The column a dotted select name projects.
 *
 * `prepare` has already resolved the key.
 *
 * @param table - The read's table
 * @param key - The dotted key
 * @returns A column whose `field` is the path
 */
function column(table: Indexed, key: string): ColumnModel {
  return hitOf(table, key).column;
}

/**
 * SQL for a selected path. Bigint and numeric come back as `::text`.
 *
 * @param column - The column {@link column} returned
 * @returns The select expression
 */
function project(column: ColumnModel): string {
  const hit = hitByColumn.get(column);
  if (hit === undefined) fail("OKM1120", `Path ${column.field} was not prepared.`);
  return projected(hit.sql("t"), column);
}

/**
 * Writes one dotted `orderBy` term. The expression is not cast, so a bigint
 * sorts numerically.
 *
 * @param table - The read's table
 * @param key - The dotted key
 * @param value - `asc`, `desc`, or `{ dir, nulls }`
 * @param sink - Statement under construction
 * @param alias - Root alias
 */
function order(table: Indexed, key: string, value: unknown, sink: Sink, alias: string): void {
  const hit = hitOf(table, key);
  const parsed = parseOrder(key, value);
  sink.text(hit.sql(alias));
  sink.text(parsed.dir === "asc" ? " asc" : " desc");
  sink.text(parsed.nulls === "first" ? " nulls first" : " nulls last");
  sink.mark(`o:${key}:${parsed.dir}:${parsed.nulls}`);
}

/**
 * Writes the to-one joins `prepare` recorded, then each table's tenant and
 * archive predicates on the join.
 *
 * @param schema - Connected schema
 * @param sink - Statement under construction
 */
function joinsOf(schema: QuerySchema, sink: Sink): void {
  for (let index = 0; index < joins.length; index += 1) {
    const join = joins[index];
    if (join === undefined) continue;
    const pairs: (readonly [string, string])[] = [];
    for (let pair = 0; pair < join.relation.local.length; pair += 1) {
      const local = join.relation.local[pair];
      const remote = join.relation.remote[pair];
      if (local === undefined || remote === undefined) continue;
      pairs.push([quote(local), quote(remote)]);
    }
    sink.mark(`pj:${join.name}`);
    sink.text(" ");
    sink.text(toOneJoinSql(quote(join.child.model.sql), join.alias, "t", pairs));
    emitWhere(schema, join.child, undefined, sink, join.alias, 1, true);
  }
}

/**
 * The group expression and the selected expression for one path.
 *
 * @param table - The aggregate's table
 * @param key - The dotted key
 * @returns Raw SQL for `group by`, projected SQL for the select list, and the codec
 */
function group(
  table: Indexed,
  key: string,
): {
  readonly expr: string;
  readonly project: string;
  readonly column: ColumnModel;
} {
  const hit = hitOf(table, key);
  const expr = hit.sql("t");
  return { expr, project: projected(expr, hit.column), column: hit.column };
}

const hitByColumn = new WeakMap<ColumnModel, Hit>();

installPaths({
  prepare,
  end,
  where,
  column,
  project,
  order,
  joins: joinsOf,
  group,
});

function hitOf(table: Indexed, key: string): Hit {
  const hit = cache.get(`${table.model.name}\0${key}`);
  if (hit === undefined) fail("OKM1120", `Path ${key} was not prepared.`);
  return hit;
}

function walk(schema: QuerySchema, table: Indexed, value: unknown, alias: string): void {
  if (isOperator(value)) {
    const name = operatorName(value);
    if (name === "or" || name === "and" || name === "not")
      walk(schema, table, operatorValue(value), alias);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) walk(schema, table, value[index], alias);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    const inner = value[key];
    if (inner === undefined) continue;
    if (key.includes(".")) {
      resolve(schema, table, key, alias);
      continue;
    }
    const relation = table.relations.get(key);
    if (relation !== undefined && isOperator(inner)) {
      const child = indexes(schema).get(relation.table);
      if (child !== undefined) walk(schema, child, operatorValue(inner), `r_${relation.name}`);
      continue;
    }
    walk(schema, table, inner, alias);
  }
}

function walkList(schema: QuerySchema, table: Indexed, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item === "string" && item.includes(".")) resolve(schema, table, item, "t");
  }
}

function resolve(schema: QuerySchema, table: Indexed, path: string, alias: string): Hit {
  const id = `${table.model.name}\0${path}`;
  const found = cache.get(id);
  if (found !== undefined) return found;
  const hit = compile(schema, table, path, alias);
  cache.set(id, hit);
  hitByColumn.set(hit.column, hit);
  return hit;
}

function compile(schema: QuerySchema, table: Indexed, path: string, alias: string): Hit {
  const dot = path.indexOf(".");
  if (dot <= 0 || dot === path.length - 1) unknown(table, path);
  const head = path.slice(0, dot);
  const rest = path.slice(dot + 1);
  const column = table.columns.get(head);
  const mark = column === undefined ? undefined : compositeMark(column.encode);
  if (mark !== undefined && column !== undefined) {
    if (mark.array) {
      fail("OKM1120", `Path ${path} reads array composite ${head}. Name a field of one value.`);
    }
    if (column.hidden === true) refuseHidden(column);
    return compositeHit(column, mark, rest, path, (next) => `${next}.${quote(column.sql)}`);
  }
  if (alias !== "t") {
    fail("OKM1120", `Path ${path} can follow a relation only from the root table.`);
  }
  const relation = table.relations.get(head);
  if (relation === undefined) unknown(table, path);
  if (relation.kind !== "one") {
    fail(
      "OKM1120",
      `Path ${path} follows ${head}, which is not a to-one relation of ${table.model.name}.`,
    );
  }
  const child = indexes(schema).get(relation.table);
  if (child === undefined) {
    fail("OKM1120", `Relation ${head} names ${relation.table}, which is not in the schema.`);
  }
  const join = ensureJoin(relation, child);
  const nestedDot = rest.indexOf(".");
  if (nestedDot >= 0) {
    const nestedHead = rest.slice(0, nestedDot);
    const nested = child.columns.get(nestedHead);
    const nestedMark = nested === undefined ? undefined : compositeMark(nested.encode);
    if (nested === undefined || nestedMark === undefined || nestedMark.array) {
      fail("OKM1120", `Path ${path} is deeper than one relation.`);
    }
    if (nested.hidden === true) refuseHidden(nested);
    return compositeHit(
      nested,
      nestedMark,
      rest.slice(nestedDot + 1),
      path,
      () => `${join.alias}.${quote(nested.sql)}`,
      true,
    );
  }
  const leaf = child.columns.get(rest);
  if (leaf === undefined) unknown(child, path);
  if (leaf.hidden === true) refuseHidden(leaf);
  const copied: ColumnModel = { ...leaf, field: path, nullable: true };
  return { column: copied, sql: () => `${join.alias}.${quote(leaf.sql)}` };
}

function compositeHit(
  parent: ColumnModel,
  mark: CompositeMark,
  rest: string,
  path: string,
  base: (alias: string) => string,
  forceNull = false,
): Hit {
  const walked = walkFields(mark, rest, path);
  const column: ColumnModel = {
    field: path,
    sql: path,
    dataType: walked.codec.dataType,
    nullable: forceNull || parent.nullable === true || walked.nullable,
    encode: walked.codec.encode,
    decode: walked.codec.decode,
    hidden: false,
    sensitive: parent.sensitive,
    guarded: false,
    writable: false,
    guardUpdate: false,
    ...(walked.codec.accepts !== undefined ? { accepts: walked.codec.accepts } : {}),
  };
  return {
    column,
    sql: (alias) => compositeAccess(base(alias), walked.names),
  };
}

function walkFields(mark: CompositeMark, rest: string, path: string): Walked {
  const names: string[] = [];
  let current = mark;
  let nullable = false;
  let text = rest;
  for (;;) {
    const dot = text.indexOf(".");
    const name = dot < 0 ? text : text.slice(0, dot);
    if (name.length === 0) fail("OKM1120", `Path ${path} is not a field of ${current.type}.`);
    const codec = current.fieldCodec(name);
    if (codec === undefined) fail("OKM1120", `Path ${path} is not a field of ${current.type}.`);
    names.push(name);
    if (codec.nullable) nullable = true;
    if (dot < 0) return { names, codec, nullable };
    if (codec.nested === undefined) {
      fail("OKM1120", `Path ${path} is not a field of ${current.type}.`);
    }
    current = codec.nested;
    text = text.slice(dot + 1);
  }
}

function ensureJoin(relation: RelationModel, child: Indexed): Join {
  for (let index = 0; index < joins.length; index += 1) {
    const join = joins[index];
    if (join !== undefined && join.name === relation.name) return join;
  }
  const join: Join = {
    name: relation.name,
    alias: `j${String(joins.length + 1)}`,
    child,
    relation,
  };
  joins.push(join);
  return join;
}

function unknown(table: Indexed, path: string): never {
  throwNamed(
    "OKM1120",
    path,
    table.names,
    `Path ${path} is not on ${table.model.name}. Accepted names: ${list(table.names)}.`,
  );
}

function projected(sql: string, column: ColumnModel): string {
  if (compositeMark(column.encode) !== undefined)
    return projectExpr(sql, column.dataType, column.encode);
  if (textCast(column.dataType)) return `(${sql})::text`;
  return projectExpr(sql, column.dataType, column.encode);
}

function textCast(dataType: string): boolean {
  const base = dataType.replace(/(?:\[\])+$/, "");
  return base === "bigint" || base === "decimal" || base.startsWith("numeric");
}
