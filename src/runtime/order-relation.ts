/**
 * `orderBy` on a relation (one hop).
 *
 * A to-one order is a left join, so a missing related row keeps the parent.
 * A to-many order is `count`: a lateral join of zero when no row matches.
 * The related table's tenant predicate and archive filter sit on that join,
 * so another tenant or an archived row does not supply the sort value.
 *
 * Loaded on the first `find` or `one` whose `orderBy` has this shape, and
 * with `page` (a stream is a page). A column order never enters here.
 * `distinct`, `distinctOn`, and `aggregate` refuse it before this loads.
 */

import { throwNamed } from "../contracts/error.js";
import type { ColumnModel, QuerySchema, RelationModel } from "../dialects/pg/model.js";
import { isOperator } from "../dialects/pg/operators.js";
import {
  emitJoin,
  emitRelationFrom,
  emitWhere,
  fail,
  indexes,
  isRecord,
  list,
  orderNamesRelation,
  parseOrder,
  projectExpr,
  quote,
  refuseHidden,
  type Built,
  type Indexed,
  type ReadCall,
  type Sink,
} from "./plan.js";

/** One sort key. A column of this table leaves the relation fields unset. */
export type SortKey = {
  readonly column?: ColumnModel;
  readonly dir: "asc" | "desc";
  readonly nulls: "first" | "last";
  /** Qualified expression. Set when the value is not a column of this table. */
  readonly expr?: string;
  /** Name of that expression in the cursor row `c`. */
  readonly cursor?: string;
  /** Output key a value cursor reads, then drops from the page row. */
  readonly slot?: string;
  /** Signature piece. A column uses its field name. */
  readonly label?: string;
  /** Result type of `expr`, for the cursor projection. */
  readonly dataType?: string;
  /** Hidden or sensitive related column. Count is never concealed. */
  readonly relationConcealed?: boolean;
};

/** One order item `writeOrder` emits. */
export type OrderItem = {
  readonly expr: string;
  readonly dir: "asc" | "desc";
  readonly nulls: "first" | "last";
  readonly mark: string;
};

/** Parsed relation order: the keys, and the joins those keys share. */
export type RelationPlan = {
  readonly keys: readonly SortKey[];
  join(sink: Sink, parent: string): void;
};

type Join = {
  readonly name: string;
  readonly alias: string;
  readonly inner: string;
  readonly count: boolean;
  readonly relation: RelationModel;
  readonly child: Indexed;
};

const HOP =
  "Order by a column of this table. A relation order is one hop: a to-one column, or count on a to-many relation.";

/**
 * Plans `orderBy` when it names a relation.
 *
 * Column keys stay in their place. Two columns of one to-one relation share
 * one left join. `count` is one lateral join.
 *
 * @param schema - Connected schema
 * @param table - The read's table
 * @param orderBy - The caller's order
 * @returns The keys and the join writer
 */
export function parseRelationOrder(
  schema: QuerySchema,
  table: Indexed,
  orderBy: unknown,
): RelationPlan {
  if (!isRecord(orderBy)) fail("OKM1120", "orderBy must be an object of fields.");
  const keys: SortKey[] = [];
  const joins: Join[] = [];
  const byName = new Map<string, Join>();
  let joinCount = 0;
  let sortCount = 0;
  for (const key of Object.keys(orderBy)) {
    const value = orderBy[key];
    const relation = table.relations.get(key);
    if (relation !== undefined && isRelationShape(value)) {
      readRelation(
        schema,
        relation,
        value,
        keys,
        joins,
        byName,
        () => {
          const alias = `o${String(joinCount)}`;
          joinCount += 1;
          return alias;
        },
        () => {
          const name = `okm${String(sortCount)}`;
          sortCount += 1;
          return name;
        },
      );
      continue;
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
    refuseHidden(column);
    if (isOperator(value)) {
      fail(
        "OKM1120",
        `orderBy ${key} must be asc or desc.`,
        "A relation order does not take relevance.",
      );
    }
    const parsed = parseOrder(key, value);
    keys.push({ column, dir: parsed.dir, nulls: parsed.nulls });
  }
  return {
    keys,
    join(sink, parent) {
      for (const join of joins) writeJoin(schema, join, sink, parent);
    },
  };
}

/**
 * Attaches the relation joins to a `find` or `one`.
 *
 * A call that is already attached is returned as it is. A column order is
 * returned as it is, and the planner keeps the path it had.
 *
 * @param schema - Connected schema
 * @param call - The read
 * @returns The read, with `rel` set when the order names a relation
 */
export function attach(schema: QuerySchema, call: ReadCall): ReadCall {
  if (call.rel !== undefined) return call;
  const table = indexes(schema).get(call.table);
  if (table === undefined || !orderNamesRelation(table, call.orderBy)) return call;
  if (Array.isArray(call.select) && call.select.some((item) => typeof item !== "string")) {
    fail(
      "OKM1120",
      "orderBy on a relation is not available with a window.",
      "Order by a column of this table, or drop the window.",
    );
  }
  const parsed = parseRelationOrder(schema, table, call.orderBy);
  return {
    ...call,
    rel: {
      join: (sink) => parsed.join(sink, "t"),
      order: (sink) => writeOrder(sink, orderItems(parsed.keys, "t")),
    },
  };
}

/**
 * Writes `order by` for the keys, in the order given.
 *
 * A column uses `parent.column`. A relation uses the expression the join
 * exposed. The mark is the same shape a column order writes.
 *
 * @param sink - Statement buffer
 * @param items - Sort expressions, already qualified
 */
export function writeOrder(sink: Sink, items: readonly OrderItem[]): void {
  if (items.length === 0) return;
  sink.text(" order by ");
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    if (index > 0) sink.text(", ");
    sink.text(item.expr);
    sink.text(item.dir === "asc" ? " asc" : " desc");
    sink.text(item.nulls === "first" ? " nulls first" : " nulls last");
    sink.mark(item.mark);
  }
}

/**
 * Turns sort keys into order items under `parent`.
 *
 * @param keys - Parsed keys, then any primary-key tie-break a page appended
 * @param parent - Root alias, `t` on the page and `k` is not used here
 * @returns The items `writeOrder` emits
 */
export function orderItems(keys: readonly SortKey[], parent: string): readonly OrderItem[] {
  return keys.map((key) => ({
    expr: key.expr ?? `${parent}.${quote(key.column?.sql ?? "")}`,
    dir: key.dir,
    nulls: key.nulls,
    mark: `o:${key.label ?? key.column?.field ?? ""}:${key.dir}:${key.nulls}`,
  }));
}

/**
 * Projects relation sort values so a value cursor can read them.
 *
 * The page drops these keys from the row it returns. A primary-key cursor
 * does not call this: the next page reads the values back from the join.
 *
 * @param sink - Statement buffer
 * @param outputs - Plan outputs. Absent while binding
 * @param at - Next output index
 * @param items - Relation values to project
 * @returns The next output index
 */
export function writeSortSelect(
  sink: Sink,
  outputs: Built | undefined,
  at: number,
  items: readonly { readonly expr: string; readonly slot: string; readonly dataType: string }[],
): number {
  let column = at;
  for (const item of items) {
    if (column > 0) sink.text(", ");
    sink.text(projectExpr(item.expr, item.dataType));
    sink.mark(`s:${item.slot}`);
    outputs?.fields.push({ key: item.slot, at: column, decode: undefined });
    column += 1;
  }
  return column;
}

function isRelationShape(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.dir === undefined && value.direction === undefined;
}

function readRelation(
  schema: QuerySchema,
  relation: RelationModel,
  value: Record<string, unknown>,
  keys: SortKey[],
  joins: Join[],
  byName: Map<string, Join>,
  aliasOf: () => string,
  cursorOf: () => string,
): void {
  if (relation.morph !== undefined) {
    fail("OKM1120", `orderBy ${relation.name} is a morph. ${HOP}`, HOP);
  }
  const names = Object.keys(value);
  if (relation.kind === "many") {
    if (names.length !== 1 || names[0] !== "count") {
      fail(
        "OKM1120",
        `orderBy ${relation.name} takes count. A to-many relation orders by the number of rows.`,
        `Pass orderBy: { ${relation.name}: { count: "desc" } }.`,
      );
    }
    const parsed = parseOrder(`${relation.name}.count`, value.count);
    const join = takeJoin(schema, relation, true, joins, byName, aliasOf);
    const cursor = cursorOf();
    keys.push({
      dir: parsed.dir,
      nulls: parsed.nulls,
      expr: `${join.alias}.n`,
      cursor,
      slot: `~${relation.name}.count`,
      label: `${relation.name}.count`,
      dataType: "bigint",
      relationConcealed: false,
    });
    return;
  }
  if (names.length === 0) {
    fail(
      "OKM1120",
      `orderBy ${relation.name} needs a column.`,
      `Pass orderBy: { ${relation.name}: { name: "asc" } }.`,
    );
  }
  const child = childOf(schema, relation);
  const join = takeJoin(schema, relation, false, joins, byName, aliasOf);
  for (const field of names) {
    if (field === "count") {
      fail(
        "OKM1120",
        `orderBy ${relation.name} takes a column. count orders a to-many relation.`,
        HOP,
      );
    }
    const column = child.columns.get(field);
    if (column === undefined) {
      throwNamed(
        "OKM1120",
        field,
        child.names,
        `Field ${field} is not on ${child.model.name}. Accepted names: ${list(child.names)}.`,
      );
    }
    refuseHidden(column);
    const parsed = parseOrder(`${relation.name}.${field}`, value[field]);
    const cursor = cursorOf();
    keys.push({
      column,
      dir: parsed.dir,
      nulls: parsed.nulls,
      expr: `${join.alias}.${quote(column.sql)}`,
      cursor,
      slot: `~${relation.name}.${field}`,
      label: `${relation.name}.${field}`,
      dataType: column.dataType,
      relationConcealed: column.sensitive === true || column.hidden !== false,
    });
  }
}

function takeJoin(
  schema: QuerySchema,
  relation: RelationModel,
  count: boolean,
  joins: Join[],
  byName: Map<string, Join>,
  aliasOf: () => string,
): Join {
  const found = byName.get(relation.name);
  if (found !== undefined) return found;
  const alias = aliasOf();
  const join: Join = {
    name: relation.name,
    alias,
    inner: `c${alias}`,
    count,
    relation,
    child: childOf(schema, relation),
  };
  byName.set(relation.name, join);
  joins.push(join);
  return join;
}

function childOf(schema: QuerySchema, relation: RelationModel): Indexed {
  const child = indexes(schema).get(relation.table);
  if (child === undefined) {
    fail(
      "OKM1120",
      `Relation ${relation.name} names ${relation.table}, which is not in the schema.`,
    );
  }
  return child;
}

function writeJoin(schema: QuerySchema, join: Join, sink: Sink, parent: string): void {
  sink.mark(`oj:${join.name}`);
  if (join.count) {
    sink.text(" left join lateral (select count(*)::bigint as n from ");
    emitRelationFrom(schema, join.relation, join.child, sink, parent, join.inner, 1);
    emitWhere(schema, join.child, undefined, sink, join.inner, 1, true);
    sink.text(") ");
    sink.text(join.alias);
    sink.text(" on true");
    return;
  }
  sink.text(" left join ");
  sink.text(quote(join.child.model.sql));
  sink.text(" ");
  sink.text(join.alias);
  sink.text(" on ");
  emitJoin(sink, parent, join.alias, join.relation);
  emitWhere(schema, join.child, undefined, sink, join.alias, 1, true);
}
