/**
 * LATERAL include planner. Loaded on the first include.
 */

import { throwNamed } from "../contracts/error.js";
import type { ColumnModel, QuerySchema, RelationModel } from "../dialects/pg/model.js";
import {
  emitJoin,
  emitRelationFrom,
  emitOrder,
  emitPrimaryOrder,
  emitWhere,
  fail,
  registerFailFix,
  indexes,
  isRecord,
  jsonExpr,
  list,
  projectExpr,
  quote,
  readLimit,
  rejectKeys,
  selectedColumns,
  cell,
  decodeResult,
  type Built,
  type IncludeOut,
  type IncludeHooks,
  type Outputs,
  type Plan,
  type Indexed,
  type ParsedInclude,
  type Sink,
} from "./plan.js";

registerFailFix("OKM1105", "Pass limit on the include, or call .all(reason).");

const INCLUDE_OPTIONS = ["all", "include", "limit", "orderBy", "select", "where"] as const;

function emitIncludeSelect(
  include: ParsedInclude,
  alias: string,
  sink: Sink,
  outputs: Built | undefined,
  column: number,
): number {
  const selected = include.columns;
  sink.mark(`i:${include.name}:${include.relation.kind}`);
  if (include.relation.kind === "many") {
    if (column > 0 || outputs?.fields.length) sink.text(", ");
    sink.text(alias);
    sink.text(".rows");
    outputs?.includes.push({
      name: include.name,
      kind: "many",
      at: column,
      fields: selected.map((item, index) => ({
        key: item.field,
        at: index,
        decode: item.decode,
      })),
      nested: include.nested.map((nested, index) => ({
        name: nested.name,
        kind: nested.relation.kind,
        at: selected.length + index,
        fields: nested.columns.map((item, at) => ({
          key: item.field,
          at,
          decode: item.decode,
        })),
        nested: [],
      })),
    });
    return column + 1;
  }
  const projected = include.presence === undefined ? selected : [...selected, include.presence];
  const start = column;
  for (let index = 0; index < projected.length; index += 1) {
    if (start + index > 0) sink.text(", ");
    sink.text(alias);
    sink.text(".c");
    sink.text(String(index));
    sink.mark(`s:${projected[index]?.field ?? ""}`);
  }
  const nestedStart = start + projected.length;
  let cursor = nestedStart;
  const nestedOut: IncludeOut[] = [];
  for (let index = 0; index < include.nested.length; index += 1) {
    const nested = include.nested[index];
    if (nested === undefined) continue;
    const width =
      nested.relation.kind === "many"
        ? 1
        : nested.presence === undefined
          ? nested.columns.length
          : nested.columns.length + 1;
    for (let slot = 0; slot < width; slot += 1) {
      sink.text(", ");
      sink.text(alias);
      sink.text(".n");
      sink.text(String(index));
      sink.text("_");
      sink.text(String(slot));
    }
    nestedOut.push({
      name: nested.name,
      kind: nested.relation.kind,
      at:
        nested.relation.kind === "many"
          ? cursor
          : nested.presence === undefined
            ? cursor
            : cursor + nested.columns.length,
      fields: nested.columns.map((item, at) => ({
        key: item.field,
        at: nested.relation.kind === "many" ? at : cursor + at,
        decode: item.decode,
      })),
      nested: [],
    });
    cursor += width;
  }
  outputs?.includes.push({
    name: include.name,
    kind: "one",
    at: start + include.anchor,
    fields: selected.map((item, index) => ({
      key: item.field,
      at: start + index,
      decode: item.decode,
    })),
    nested: nestedOut,
  });
  return cursor;
}

function emitIncludeJoin(
  schema: QuerySchema,
  include: ParsedInclude,
  sink: Sink,
  parentAlias: string,
  alias: string,
  depth: number,
): void {
  const child = indexes(schema).get(include.relation.table);
  if (child === undefined) {
    fail(
      "OKM1120",
      `Relation ${include.name} names ${include.relation.table}, which is not in the schema.`,
    );
  }
  const childAlias = `r${String(depth)}_${include.name}`;
  sink.text(" left join lateral (");
  if (include.relation.kind === "many") {
    sink.text(
      "select coalesce(json_agg(item order by ord), '[]'::json) as rows from (select item, row_number() over () as ord from (select json_build_array(",
    );
    const selected = include.columns;
    for (let index = 0; index < selected.length; index += 1) {
      const item = selected[index];
      if (item === undefined) continue;
      if (index > 0) sink.text(", ");
      sink.text(jsonExpr(`${childAlias}.${quote(item.sql)}`, item.dataType));
    }
    if (selected.length === 0) sink.text("1");
    for (const nested of include.nested) {
      sink.text(", ");
      emitNestedAggregate(schema, nested, sink, childAlias, depth + 1);
    }
    sink.text(") as item from ");
    emitRelationFrom(schema, include.relation, child, sink, parentAlias, childAlias, depth + 1);
    emitWhere(schema, child, include.where, sink, childAlias, depth + 1, true);
    emitOrder(child, include.orderBy, sink, childAlias);
    if (include.orderBy === undefined && child.model.primary.length > 0) {
      emitPrimaryOrder(child, sink, childAlias);
    }
    if (include.limit !== undefined) {
      sink.text(" limit ");
      sink.param(String(include.limit));
      sink.mark(`l:${String(include.limit)}`);
    }
    sink.text(") limited) ordered) ");
    sink.text(alias);
    sink.text(" on true");
    return;
  }
  sink.text("select ");
  const projected =
    include.presence === undefined ? include.columns : [...include.columns, include.presence];
  for (let index = 0; index < projected.length; index += 1) {
    const item = projected[index];
    if (item === undefined) continue;
    if (index > 0) sink.text(", ");
    sink.text(projectExpr(`${childAlias}.${quote(item.sql)}`, item.dataType));
    sink.text(" as c");
    sink.text(String(index));
  }
  if (projected.length === 0) sink.text("1 as c0");
  for (let index = 0; index < include.nested.length; index += 1) {
    const nested = include.nested[index];
    if (nested === undefined) continue;
    if (nested.relation.kind === "many") {
      sink.text(", ");
      sink.text("n");
      sink.text(String(index));
      sink.text(".rows as n");
      sink.text(String(index));
      sink.text("_0");
      continue;
    }
    const width = nested.presence === undefined ? nested.columns.length : nested.columns.length + 1;
    for (let slot = 0; slot < width; slot += 1) {
      sink.text(", ");
      sink.text("n");
      sink.text(String(index));
      sink.text(".c");
      sink.text(String(slot));
      sink.text(" as n");
      sink.text(String(index));
      sink.text("_");
      sink.text(String(slot));
    }
  }
  sink.text(" from ");
  sink.text(quote(child.model.sql));
  sink.text(" ");
  sink.text(childAlias);
  for (let index = 0; index < include.nested.length; index += 1) {
    const nested = include.nested[index];
    if (nested === undefined) continue;
    emitIncludeJoin(schema, nested, sink, childAlias, `n${String(index)}`, depth + 1);
  }
  sink.text(" where ");
  emitJoin(sink, parentAlias, childAlias, include.relation);
  emitWhere(schema, child, include.where, sink, childAlias, depth + 1, true);
  sink.text(" limit 1) ");
  sink.text(alias);
  sink.text(" on true");
}

function emitNestedAggregate(
  schema: QuerySchema,
  include: ParsedInclude,
  sink: Sink,
  alias: string,
  depth: number,
): void {
  const child = indexes(schema).get(include.relation.table);
  if (child === undefined) {
    fail(
      "OKM1120",
      `Relation ${include.name} names ${include.relation.table}, which is not in the schema.`,
    );
  }
  const childAlias = `n${String(depth)}_${include.name}`;
  sink.text(
    "(select coalesce(json_agg(item order by ord), '[]'::json) from (select item, row_number() over () as ord from (select json_build_array(",
  );
  for (let index = 0; index < include.columns.length; index += 1) {
    const item = include.columns[index];
    if (item === undefined) continue;
    if (index > 0) sink.text(", ");
    sink.text(jsonExpr(`${childAlias}.${quote(item.sql)}`, item.dataType));
  }
  if (include.columns.length === 0) sink.text("1");
  sink.text(") as item from ");
  emitRelationFrom(schema, include.relation, child, sink, alias, childAlias, depth);
  emitWhere(schema, child, include.where, sink, childAlias, depth, true);
  emitOrder(child, include.orderBy, sink, childAlias);
  if (include.orderBy === undefined && child.model.primary.length > 0) {
    emitPrimaryOrder(child, sink, childAlias);
  }
  if (include.limit !== undefined) {
    sink.text(" limit ");
    sink.param(String(include.limit));
    sink.mark(`l:${String(include.limit)}`);
  }
  sink.text(") limited) ordered)");
}

/** Includes never return a hidden column, even when `select` names it. */
function omitHidden(columns: readonly ColumnModel[]): readonly ColumnModel[] {
  for (const column of columns) {
    if (!column.hidden) continue;
    return columns.filter((item) => !item.hidden);
  }
  return columns;
}

function readIncludes(
  schema: QuerySchema,
  table: Indexed,
  include: unknown,
  all: string | undefined,
): readonly ParsedInclude[] {
  if (include === undefined) return [];
  if (!isRecord(include)) {
    fail("OKM1120", "include must be an object of relations.");
  }
  const parsed: ParsedInclude[] = [];
  for (const name of Object.keys(include)) {
    const relation = table.relations.get(name);
    if (relation === undefined) {
      throwNamed(
        "OKM1120",
        name,
        [...table.relations.keys()],
        `Include ${name} is not a relation of ${table.model.name}. Accepted names: ${list([...table.relations.keys()])}.`,
      );
    }
    parsed.push(parseInclude(schema, name, relation, include[name], all));
  }
  return parsed;
}

function parseInclude(
  schema: QuerySchema,
  name: string,
  relation: RelationModel,
  value: unknown,
  all: string | undefined,
): ParsedInclude {
  if (value === true) {
    if (relation.kind === "many" && all === undefined) {
      fail(
        "OKM1105",
        `Include ${name} is to-many and has no limit. Pass limit, or call .all(reason).`,
      );
    }
    const child = childIndex(schema, relation);
    const columns = omitHidden(selectedColumns(child, undefined));
    return {
      name,
      relation,
      where: undefined,
      orderBy: undefined,
      limit: undefined,
      columns,
      ...anchored(child, columns),
      nested: [],
    };
  }
  if (!isRecord(value)) {
    fail("OKM1120", `Include ${name} must be true or an object.`);
  }
  rejectKeys(value, INCLUDE_OPTIONS, `include ${name}`);
  const reason = typeof value.all === "string" ? value.all : all;
  let limit: number | undefined;
  if (value.limit !== undefined) limit = readLimit(value.limit);
  if (relation.kind === "many" && limit === undefined && reason === undefined) {
    fail(
      "OKM1105",
      `Include ${name} is to-many and has no limit. Pass limit, or call .all(reason).`,
    );
  }
  const child = childIndex(schema, relation);
  const columns = omitHidden(selectedColumns(child, value.select));
  const nestedValue = value.include;
  const nested = nestedValue === undefined ? [] : readIncludes(schema, child, nestedValue, reason);
  return {
    name,
    relation,
    where: value.where,
    orderBy: value.orderBy,
    limit,
    columns,
    ...anchored(child, columns),
    nested,
  };
}

function anchored(
  table: Indexed,
  columns: readonly ColumnModel[],
): { readonly presence: ColumnModel | undefined; readonly anchor: number } {
  const pk = table.model.primary[0];
  // No primary key: the first projected column is null only when the join misses.
  if (pk === undefined) return { presence: undefined, anchor: 0 };
  const selected = columns.findIndex((column) => column.field === pk);
  if (selected >= 0) return { presence: undefined, anchor: selected };
  return { presence: table.columns.get(pk), anchor: columns.length };
}

function childIndex(schema: QuerySchema, relation: RelationModel): Indexed {
  const child = indexes(schema).get(relation.table);
  if (child === undefined) {
    fail(
      "OKM1120",
      `Relation ${relation.name} names ${relation.table}, which is not in the schema.`,
    );
  }
  return child;
}

/**
 * Decodes a result that has includes.
 *
 * @param plan - Compiled plan
 * @param rows - Wire rows
 * @param table - Table the call named
 * @returns The call's value
 */
export function decodeIncluded(
  plan: Plan,
  rows: readonly (readonly (string | null)[])[],
  table: string,
): unknown {
  return decodeResult(plan, rows, table, decodeRowIncluded);
}

function decodeRowIncluded(
  outputs: Outputs,
  row: readonly (string | null)[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of outputs.fields) {
    result[field.key] = cell(row[field.at], field.decode);
  }
  for (const include of outputs.includes) {
    result[include.name] = decodeInclude(include, row);
  }
  return result;
}

function decodeInclude(include: IncludeOut, row: readonly (string | null)[]): unknown {
  if (include.kind === "many") {
    const raw = row[include.at];
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const rows: Record<string, unknown>[] = [];
    for (const item of parsed) {
      if (!Array.isArray(item)) continue;
      const child: Record<string, unknown> = {};
      for (const field of include.fields) {
        child[field.key] = jsonCell(item[field.at], field.decode);
      }
      for (const nested of include.nested) {
        child[nested.name] = decodeJsonInclude(nested, item[nested.at]);
      }
      rows.push(child);
    }
    return rows;
  }
  const presence = row[include.at];
  if (presence === null || presence === undefined) return null;
  const child: Record<string, unknown> = {};
  for (const field of include.fields) {
    child[field.key] = cell(row[field.at], field.decode);
  }
  for (const nested of include.nested) {
    child[nested.name] = decodeInclude(nested, row);
  }
  return child;
}

function decodeJsonInclude(include: IncludeOut, value: unknown): unknown {
  if (!Array.isArray(value)) return include.kind === "many" ? [] : null;
  const rows: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!Array.isArray(item)) continue;
    const child: Record<string, unknown> = {};
    for (const field of include.fields) {
      child[field.key] = jsonCell(item[field.at], field.decode);
    }
    rows.push(child);
  }
  return include.kind === "one" ? (rows[0] ?? null) : rows;
}

function jsonCell(value: unknown, decode: ((wire: string) => unknown) | undefined): unknown {
  if (value === null || value === undefined) return null;
  const wire = typeof value === "string" ? value : JSON.stringify(value);
  return decode === undefined ? wire : decode(wire);
}

/** Hooks the read planner calls after this module has loaded. */
export const includeHooks: IncludeHooks = {
  read: readIncludes,
  select: emitIncludeSelect,
  join: emitIncludeJoin,
};
