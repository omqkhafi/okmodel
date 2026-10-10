/**
 * Path tenancy.
 *
 * A table with `tenancy: { via: "project.organization" }` has no tenant column.
 * Reads and writes add `EXISTS` along that relation path. An insert checks the
 * parent in the same statement. The featureless app does not import this file.
 */

import { OkmError } from "../../contracts/error.js";
import { ColumnBuilder, retarget } from "../../dialects/pg/column.js";
import { isRelationCall } from "../../dialects/pg/relations.js";
import { index, snakeCase, type AnyTable } from "../../dialects/pg/table.js";
import type { TenancyText, TenantCall } from "../../dialects/pg/tenancy.js";
import { quote } from "../plan.js";

/** How `columnTenancy()` classified a table before the rewrite. */
export type TableKind = "tenant" | "global" | "path";

/** One step from a path table toward the tenant table. */
export type PathHop = {
  /** Table that declares this step. */
  readonly child: string;
  /** Table this step points at. */
  readonly parent: string;
  /** Foreign-key field on `child`. */
  readonly localField: string;
  /** Field on `parent` that the foreign key matches. */
  readonly remoteField: string;
  /** SQL name stored on the local column, when the builder set one. */
  readonly localSql: string | undefined;
  /** SQL name stored on the remote column, when the builder set one. */
  readonly remoteSql: string | undefined;
  /** SQL name stored on the parent table, when the table set one. */
  readonly parentSql: string | undefined;
  /** Encodes the local field when an update points it at a new parent. */
  readonly encode: (value: string) => string;
};

/** A resolved `via` path. */
export type PathChain = {
  /** The `via` text, unchanged. */
  readonly via: string;
  /** Steps from the path table to the tenant table. At most three. */
  readonly hops: readonly PathHop[];
};

type TableOptions = {
  readonly tenancy?: unknown;
  readonly relations?: Readonly<Record<string, unknown>>;
  readonly indexes?: (columns: Readonly<Record<string, { readonly name: string }>>) => readonly {
    readonly columns: readonly string[];
  }[];
  readonly sqlName?: string;
  readonly primaryKey?: readonly string[];
};

/** What the column strategy asks of a resolved path. */
export type PathPlan = {
  /** Tenant tables a path ends on, and the declared key that must stay unique. */
  readonly endpoints: ReadonlyMap<string, readonly string[]>;
  /** Path table, when `name` was resolved. */
  isPath(name: string): boolean;
  /** Steps from `name` to the tenant table. */
  hops(name: string): readonly PathHop[] | undefined;
  /** Rewrites one path table: foreign key into the tenant table, and the index. */
  adjust(item: AnyTable): AnyTable;
  /**
   * Writes `EXISTS` for a path table.
   *
   * @returns `true` when `table` is a path table and the predicate was written
   */
  writeExists(input: ExistsInput): boolean;
};

type ExistsInput = {
  readonly table: string;
  readonly alias: string;
  readonly fieldSql: (field: string) => string | undefined;
  readonly scope: TenantCall | undefined;
  readonly sink: TenancyText;
  readonly appended: boolean;
  readonly lock: boolean;
  readonly keys: readonly string[];
  readonly encodeKey: (key: string, value: string) => string;
  /** New parent values, keyed by the path table's foreign-key field. */
  readonly assigned?: Readonly<Record<string, string>>;
};

const MAX_HOPS = 3;

/**
 * Resolves every `tenancy: { via }` table.
 *
 * A path that does not end at a tenant table, a missing relation, a cycle, or
 * more than three hops is OKM1705. The caller rewrites tenant tables after this
 * and adds a unique on each endpoint's declared key.
 *
 * @param tables - Tables passed to `schema()`
 * @param kind - Classification, including `"path"`
 * @returns The plan the predicate and the rewrite share
 */
export function compilePaths(
  tables: readonly AnyTable[],
  kind: ReadonlyMap<string, TableKind>,
): PathPlan {
  const chains = new Map<string, PathChain>();
  const endpoints = new Map<string, readonly string[]>();
  for (const item of tables) {
    if (kind.get(item.name) !== "path") continue;
    const via = viaOf(item);
    const hops = resolve(item, via, tables, kind, new Set([item.name]));
    chains.set(item.name, { via, hops });
    const last = hops[hops.length - 1];
    if (last === undefined) continue;
    const parent = tables.find((table) => table.name === last.parent);
    const declared = parent === undefined ? [] : declaredPrimary(parent);
    if (declared.length === 0) {
      pathError(
        `Table ${item.name} tenancy via "${via}" ends at ${last.parent}, which has no primary key.`,
      );
    }
    endpoints.set(last.parent, declared);
  }
  return {
    endpoints,
    isPath: (name) => chains.has(name),
    hops: (name) => chains.get(name)?.hops,
    adjust: (item) => adjust(item, chains.get(item.name), kind, tables),
    writeExists: (input) => writeExists(chains.get(input.table), input),
  };
}

/**
 * Reads `tenancy: { via }` from a table.
 *
 * @param item - Table already classified as a path
 * @returns The path text
 */
function viaOf(item: AnyTable): string {
  const mark = (item.options as TableOptions | undefined)?.tenancy;
  if (!isRecord(mark) || typeof mark.via !== "string" || mark.via.trim().length === 0) {
    pathError(`Table ${item.name} tenancy via needs a relation path.`);
  }
  return mark.via.trim();
}

function resolve(
  item: AnyTable,
  via: string,
  tables: readonly AnyTable[],
  kind: ReadonlyMap<string, TableKind>,
  seen: Set<string>,
): readonly PathHop[] {
  const segments = via.split(".");
  if (segments.length > MAX_HOPS) {
    pathError(`Table ${item.name} tenancy via "${via}" is longer than 3 hops.`);
  }
  const hops: PathHop[] = [];
  let current = item;
  for (const segment of segments) {
    if (segment.length === 0) {
      pathError(`Table ${item.name} tenancy via "${via}" has an empty step.`);
    }
    const relations = (current.options as TableOptions | undefined)?.relations;
    const call = relations?.[segment];
    if (!isRelationCall(call) || call.kind !== "one") {
      pathError(`Table ${current.name} tenancy via "${via}" has no to-one relation ${segment}.`);
    }
    if (seen.has(call.table)) {
      pathError(`Table ${item.name} tenancy via "${via}" cycles at ${call.table}.`);
    }
    const parent = tables.find((table) => table.name === call.table);
    if (parent === undefined) {
      pathError(
        `Table ${current.name} tenancy via "${via}" names ${call.table}, which is not in the schema.`,
      );
    }
    const localField = localOf(current, call.field, parent.name, segment, via);
    const remoteField = remoteOf(parent, localField, current, via);
    seen.add(parent.name);
    hops.push({
      child: current.name,
      parent: parent.name,
      localField,
      remoteField,
      localSql: sqlNameOf(current, localField),
      remoteSql: sqlNameOf(parent, remoteField),
      parentSql: (parent.options as TableOptions | undefined)?.sqlName,
      encode: encodeOf(current, localField),
    });
    current = parent;
  }
  const end = kind.get(current.name);
  if (end !== "tenant") {
    pathError(
      `Table ${item.name} tenancy via "${via}" ends at ${current.name}, which is not a tenant table.`,
    );
  }
  return hops;
}

function localOf(
  table: AnyTable,
  field: string | undefined,
  parent: string,
  segment: string,
  via: string,
): string {
  if (field !== undefined) {
    if (!Object.hasOwn(table.columns, field)) {
      pathError(`Table ${table.name} relation ${segment} names ${field}, which is not a column.`);
    }
    return field;
  }
  const found: string[] = [];
  for (const [name, builder] of Object.entries(table.columns)) {
    if (!(builder instanceof ColumnBuilder)) continue;
    if (builder.state.references?.table === parent) found.push(name);
  }
  const only = found.length === 1 ? found[0] : undefined;
  if (only === undefined) {
    pathError(
      `Table ${table.name} tenancy via "${via}" cannot tell which column points at ${parent}. Name it on ${segment}.`,
    );
  }
  return only;
}

function remoteOf(parent: AnyTable, localField: string, child: AnyTable, via: string): string {
  const builder = child.columns[localField];
  const named = builder instanceof ColumnBuilder ? builder.state.references?.columns : undefined;
  if (named !== undefined && named.length === 1 && named[0] !== undefined) return named[0];
  if (named !== undefined && named.length !== 1) {
    pathError(
      `Table ${child.name} tenancy via "${via}" points ${localField} at ${String(named.length)} columns on ${parent.name}.`,
    );
  }
  const declared = declaredPrimary(parent);
  if (declared.length !== 1 || declared[0] === undefined) {
    pathError(
      `Table ${child.name} tenancy via "${via}" needs one primary column on ${parent.name}.`,
    );
  }
  return declared[0];
}

function adjust(
  item: AnyTable,
  chain: PathChain | undefined,
  kind: ReadonlyMap<string, TableKind>,
  tables: readonly AnyTable[],
): AnyTable {
  if (chain === undefined) return item;
  const first = chain.hops[0];
  const options = item.options as TableOptions | undefined;
  const columns: Record<string, object> = { ...item.columns };
  for (const hop of chain.hops) {
    if (hop.child !== item.name) continue;
    if (kind.get(hop.parent) !== "tenant") continue;
    const builder = columns[hop.localField];
    if (!(builder instanceof ColumnBuilder) || builder.state.references === undefined) continue;
    const parent = tables.find((table) => table.name === hop.parent);
    const declared = parent === undefined ? [hop.remoteField] : declaredPrimary(parent);
    columns[hop.localField] = retarget(builder, {
      references: { ...builder.state.references, columns: declared },
    });
  }
  const field = first?.localField;
  const indexes =
    field === undefined ? options?.indexes : leadingIndex(item.name, field, options?.indexes);
  return {
    ...item,
    columns,
    options: {
      ...options,
      ...(indexes !== undefined ? { indexes } : {}),
    },
  };
}

function leadingIndex(
  table: string,
  field: string,
  previous: TableOptions["indexes"],
): TableOptions["indexes"] {
  return (columns) => {
    const handle = columns[field];
    if (handle === undefined) {
      throw new OkmError(
        "OKM1706",
        `Index on ${table} does not lead with ${field}. Put ${field} first.`,
      );
    }
    const calls = previous === undefined ? [] : previous(columns);
    if (!Array.isArray(calls)) return calls;
    if (calls.some((call) => call.columns[0] === handle.name)) return calls;
    return [index(handle), ...calls];
  };
}

function writeExists(chain: PathChain | undefined, input: ExistsInput): boolean {
  if (chain === undefined) return false;
  const scope = input.scope;
  if (scope === undefined) {
    throw new OkmError(
      "OKM1701",
      `Table ${input.table} is tenant-scoped. Call for({ ${input.keys.join(", ")} }) or unscoped("reason").`,
    );
  }
  if ("unscoped" in scope) {
    input.sink.mark("unscoped|");
    return false;
  }
  input.sink.text(input.appended ? " and " : " where ");
  const snake = snakeOn(chain, input.fieldSql);
  emitHop(chain, 0, input, snake, scope);
  input.sink.mark("tenant|");
  return true;
}

function emitHop(
  chain: PathChain,
  index: number,
  input: ExistsInput,
  snake: boolean,
  scope: { readonly value: string; readonly values?: Readonly<Record<string, string>> },
): void {
  const hop = chain.hops[index];
  if (hop === undefined) return;
  const parentAlias = `p${String(index)}`;
  const last = index === chain.hops.length - 1;
  input.sink.text("exists (select 1 from ");
  input.sink.text(quote(tableSql(hop.parent, hop.parentSql, snake)));
  input.sink.text(" ");
  input.sink.text(parentAlias);
  input.sink.text(" where ");
  input.sink.text(parentAlias);
  input.sink.text(".");
  input.sink.text(quote(columnSql(hop.remoteField, hop.remoteSql, snake)));
  input.sink.text(" = ");
  const assigned = index === 0 ? input.assigned?.[hop.localField] : undefined;
  if (assigned !== undefined) {
    input.sink.param(assigned);
  } else {
    const qualifier = index === 0 ? input.alias : `p${String(index - 1)}`;
    input.sink.text(qualifier);
    input.sink.text(".");
    input.sink.text(quote(columnSql(hop.localField, hop.localSql, snake)));
  }
  if (!last) {
    input.sink.text(" and ");
    emitHop(chain, index + 1, input, snake, scope);
  } else {
    for (const key of input.keys) {
      input.sink.text(" and ");
      input.sink.text(parentAlias);
      input.sink.text(".");
      input.sink.text(quote(columnSql(key, undefined, snake)));
      input.sink.text(" = ");
      const raw = scope.values?.[key] ?? scope.value;
      input.sink.param(input.encodeKey(key, raw));
    }
    if (input.lock) input.sink.text(" for share");
  }
  input.sink.text(")");
}

function snakeOn(chain: PathChain, fieldSql: (field: string) => string | undefined): boolean {
  const hop = chain.hops[0];
  if (hop === undefined || hop.localSql !== undefined) return false;
  const live = fieldSql(hop.localField);
  const snake = snakeCase(hop.localField);
  return live !== undefined && live === snake && live !== hop.localField;
}

function columnSql(field: string, explicit: string | undefined, snake: boolean): string {
  if (explicit !== undefined) return explicit;
  return snake ? snakeCase(field) : field;
}

function tableSql(name: string, explicit: string | undefined, snake: boolean): string {
  if (explicit !== undefined) return explicit;
  return snake ? snakeCase(name) : name;
}

/**
 * Declared primary key, before tenancy adds its columns.
 *
 * @param item - Table as passed to `schema()`
 * @returns Field names, in declaration order
 */
export function declaredPrimary(item: AnyTable): readonly string[] {
  const listed = (item.options as TableOptions | undefined)?.primaryKey;
  if (listed !== undefined && listed.length > 0) return [...listed];
  const fields: string[] = [];
  for (const [field, builder] of Object.entries(item.columns)) {
    if (builder instanceof ColumnBuilder && builder.state.primaryKey === true) fields.push(field);
  }
  return fields;
}

function sqlNameOf(table: AnyTable, field: string): string | undefined {
  const builder = table.columns[field];
  if (!(builder instanceof ColumnBuilder)) return undefined;
  return builder.state.sqlName;
}

function encodeOf(table: AnyTable, field: string): (value: string) => string {
  const builder = table.columns[field];
  if (!(builder instanceof ColumnBuilder)) return (value) => value;
  const encode = builder.state.encode;
  return (value) => encode(value);
}

function pathError(message: string): never {
  throw new OkmError("OKM1705", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
