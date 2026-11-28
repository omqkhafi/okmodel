/**
 * Static warning checks.
 *
 * Each rule reads the planned read. Nothing here asks the database or the
 * write observer.
 */

import { isOperator, operatorName, operatorValue } from "../../dialects/pg/operators.js";
import type { QuerySchema, RelationModel, TableModel } from "../../dialects/pg/model.js";
import type { Catalog } from "../../contracts/catalog/types.js";
import type { CallScope, IncludeOut, ReadDone } from "../plan.js";
import {
  FANOUT_LIMIT,
  isWarningRecord,
  LIST_LIMIT,
  OFFSET_LIMIT,
  type WarningRule,
} from "./catalog.js";

/** The read fields a static rule reads. */
export type WarningCall = {
  readonly op: string;
  readonly table: string;
  readonly where?: unknown;
  readonly orderBy?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
  readonly include?: unknown;
  readonly ignore?: unknown;
  readonly build?: unknown;
  /** Set when the read has `computed`. Read structurally by OKM2012. */
  readonly computed?: unknown;
  /** Key and value of the root default `connect({ limits })` applied. */
  readonly dl?: readonly [key: string, value: number];
  /** Tenant scope of the call. Absent on a client that has none. */
  readonly scope?: CallScope;
};

const LIST_OPS = new Set([
  "inList",
  "notIn",
  "overlaps",
  "contains",
  "containedBy",
  "hasAnyKey",
  "eq",
]);

/**
 * Reports whether one rule matches this read.
 *
 * A rule with `observed` evidence reads the finished read and needs `done`.
 * The others read the planned read and never see `done`.
 *
 * @param rule - Registered rule
 * @param schema - Connected schema
 * @param call - Planned read
 * @param done - The plan and value of a finished read
 * @returns The defaults that were reached for OKM2011, `true` for another rule that fires, or `false`
 */
export function ruleFires(
  rule: WarningRule,
  schema: QuerySchema,
  call: WarningCall,
  done?: ReadDone,
): boolean | string {
  if ((rule.evidence === "observed") !== (done !== undefined)) return false;
  if (rule.code === "OKM2011") return defaultReached(call, done);
  if (rule.code === "OKM2004") return deepOffset(call);
  if (rule.code === "OKM2005") return unorderedLimit(schema, call);
  if (rule.code === "OKM2007") return largeList(call);
  if (rule.code === "OKM2008") return wideFanOut(schema, call);
  if (rule.code === "OKM2012") return unindexedComputed(schema, call);
  if (rule.code === "OKM2130") return partitionScan(schema, call);
  return false;
}

function partitionScan(schema: QuerySchema, call: WarningCall): boolean {
  const table = schema.model[call.table];
  const keys = table?.partitionKey;
  if (keys === undefined || keys.length === 0) return false;
  if (call.op === "insert" || call.op === "upsert") return false;
  if (tenantCovers(schema, call, keys)) return false;
  return !mentions(call.where, new Set(keys));
}

function tenantCovers(schema: QuerySchema, call: WarningCall, keys: readonly string[]): boolean {
  if (call.scope === undefined || "unscoped" in call.scope) return false;
  const tenancy = schema.tenancy;
  if (tenancy === undefined) return false;
  const covered =
    tenancy.keys !== undefined && tenancy.keys.length > 0 ? tenancy.keys : [tenancy.key];
  return keys.every((key) => covered.includes(key));
}

function mentions(value: unknown, keys: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => mentions(item, keys));
  if (typeof value !== "object" || value === null) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (keys.has(key)) return true;
    if (mentions(nested, keys)) return true;
  }
  return false;
}

/**
 * Names the defaults whose row count equals the default.
 *
 * `page()` is left out: it returns a cursor, so a full page is not a cut-off.
 * A tree walk is left out too. Its stack is taken after the lazy import, so
 * the caller frame is missing and the notice would share a key with every
 * other limit that also has no caller. An include counts when any parent got
 * exactly the default.
 */
function defaultReached(call: WarningCall, done: ReadDone | undefined): false | string {
  if (done === undefined) return false;
  const rows = rowsOf(done.value);
  const found: string[] = [];
  const root = call.dl;
  const walk = call.op === "descendants" || call.op === "ancestors";
  if (root !== undefined && root[0] !== "page" && !walk && rows.length === root[1]) {
    found.push(`limits.${root[0]} = ${String(root[1])}`);
  }
  const limit = includeReached(done.plan.outputs.includes, rows);
  if (limit !== undefined) found.push(`limits.include = ${String(limit)}`);
  return found.length === 0 ? false : found.join(", ");
}

function rowsOf(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (!isWarningRecord(value)) return [];
  return Array.isArray(value.items) ? value.items : [value];
}

function includeReached(
  includes: readonly IncludeOut[],
  rows: readonly unknown[],
): number | undefined {
  for (const include of includes) {
    const children: unknown[] = [];
    for (const row of rows) {
      const value = isWarningRecord(row) ? row[include.name] : undefined;
      if (Array.isArray(value)) {
        if (include.dl !== undefined && value.length === include.dl) return include.dl;
        children.push(...value);
      } else if (isWarningRecord(value)) children.push(value);
    }
    const nested = includeReached(include.nested, children);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function deepOffset(call: WarningCall): boolean {
  return (
    typeof call.offset === "number" && Number.isInteger(call.offset) && call.offset > OFFSET_LIMIT
  );
}

function unorderedLimit(schema: QuerySchema, call: WarningCall): boolean {
  if (call.op !== "find" || call.build !== undefined || typeof call.limit !== "number")
    return false;
  const table = schema.model[call.table];
  if (table === undefined) return false;
  return !endsWithUnique(call.orderBy, uniquesFor(schema, table, call.scope));
}

/**
 * Unique sets OKM2005 compares against.
 *
 * A `for()` scope pins the tenant key, so that column is not part of the
 * order. A declared unique stored as `(tenantKey, email)` counts as `email`.
 * An unscoped call, a root call, and a `via()` table (no tenant column) keep
 * the sets as stored.
 */
function uniquesFor(
  schema: QuerySchema,
  table: TableModel,
  scope: CallScope | undefined,
): readonly (readonly string[])[] {
  if (scope === undefined || "unscoped" in scope) return table.uniques;
  const tenancy = schema.tenancy;
  if (tenancy === undefined) return table.uniques;
  const keys = tenancy.keys !== undefined && tenancy.keys.length > 0 ? tenancy.keys : [tenancy.key];
  let present = false;
  for (const column of table.columns) {
    if (keys.includes(column.field)) {
      present = true;
      break;
    }
  }
  if (!present) return table.uniques;
  const next: string[][] = [];
  for (const unique of table.uniques) {
    const kept: string[] = [];
    for (const field of unique) if (!keys.includes(field)) kept.push(field);
    next.push(kept);
  }
  return next;
}

function endsWithUnique(orderBy: unknown, uniques: readonly (readonly string[])[]): boolean {
  if (!isWarningRecord(orderBy)) return false;
  const keys = Object.keys(orderBy);
  for (const unique of uniques) {
    if (unique.length === 0 || unique.length > keys.length) continue;
    const tail = keys.slice(keys.length - unique.length);
    if (sameSet(tail, unique)) return true;
  }
  return false;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(left);
  for (const name of right) if (!seen.has(name)) return false;
  return true;
}

function largeList(call: WarningCall): boolean {
  let found = false;
  walk(call.where, () => {
    found = true;
  });
  walkInclude(call.include, () => {
    found = true;
  });
  return found;
}

function walk(value: unknown, hit: () => void): void {
  if (isOperator(value)) {
    const name = operatorName(value);
    const operand = operatorValue(value);
    if (name === "and" || name === "or" || name === "not") {
      walk(operand, hit);
      return;
    }
    if (name === "between") return;
    if (LIST_OPS.has(name) && Array.isArray(operand) && operand.length > LIST_LIMIT) hit();
    return;
  }
  if (Array.isArray(value)) {
    if (
      value.length > LIST_LIMIT &&
      value.every((item) => !isOperator(item) && !isWarningRecord(item))
    ) {
      hit();
    }
    for (const item of value) walk(item, hit);
    return;
  }
  if (!isWarningRecord(value)) return;
  for (const nested of Object.values(value)) walk(nested, hit);
}

function walkInclude(include: unknown, hit: () => void): void {
  if (!isWarningRecord(include)) return;
  for (const spec of Object.values(include)) {
    if (!isWarningRecord(spec)) continue;
    walk(spec.where, hit);
    walkInclude(spec.include, hit);
  }
}

function wideFanOut(schema: QuerySchema, call: WarningCall): boolean {
  const parent = whole(call.limit);
  if (parent === undefined || !isWarningRecord(call.include)) return false;
  const table = schema.model[call.table];
  if (table === undefined) return false;
  for (const [name, spec] of Object.entries(call.include)) {
    const relation = relationOf(table, name);
    if (relation === undefined) continue;
    if (exceeds(schema, parent, relation, spec)) return true;
  }
  return false;
}

function exceeds(
  schema: QuerySchema,
  parent: number,
  relation: RelationModel,
  spec: unknown,
): boolean {
  const limit = childLimit(relation, spec);
  if (limit === undefined) return false;
  const product = parent * limit;
  if (product > FANOUT_LIMIT) return true;
  if (!isWarningRecord(spec) || !isWarningRecord(spec.include)) return false;
  const child = schema.model[relation.table];
  if (child === undefined) return false;
  for (const [name, nested] of Object.entries(spec.include)) {
    const next = relationOf(child, name);
    if (next === undefined) continue;
    if (exceeds(schema, product, next, nested)) return true;
  }
  return false;
}

function childLimit(relation: RelationModel, spec: unknown): number | undefined {
  if (spec === true) return relation.kind === "one" ? 1 : undefined;
  if (!isWarningRecord(spec)) return undefined;
  if (spec.limit === undefined) return relation.kind === "one" ? 1 : undefined;
  return whole(spec.limit);
}

function relationOf(table: TableModel, name: string): RelationModel | undefined {
  for (const relation of table.relations) if (relation.name === name) return relation;
  return undefined;
}

function whole(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

type ComputedKey = {
  readonly table: string;
  readonly relation: string;
  readonly columns: readonly string[];
};

/**
 * Names the related tables a `computed` read groups by a key no declared index starts with.
 *
 * A primary key, a unique constraint, and an index whose first columns are the
 * key all count, and so does an index that puts the tenant key first.
 * An expression index makes the columns undecidable, so the rule stays silent.
 */
function unindexedComputed(schema: QuerySchema, call: WarningCall): false | string {
  const keys = isWarningRecord(call.computed) ? call.computed.keys : undefined;
  const catalog = (schema as { readonly catalog?: Catalog }).catalog;
  if (!Array.isArray(keys) || catalog === undefined) return false;
  const found: string[] = [];
  for (const key of keys as readonly ComputedKey[]) {
    const model = schema.model[key.table];
    if (model === undefined || key.columns.length === 0) continue;
    const lists = indexLists(catalog, model.sql);
    if (lists === undefined || covered(lists, key.columns, tenantColumns(schema, model))) continue;
    const fields = key.columns.map((column) => model.columns.find((c) => c.sql === column)?.field);
    if (fields.includes(undefined)) continue;
    const args = fields.map((field) => `columns.${String(field)}`).join(", ");
    found.push(`${key.table} indexes: (columns) => [index(${args})]`);
  }
  return found.length === 0 ? false : found.join("; ");
}

function indexLists(catalog: Catalog, table: string): readonly (readonly string[])[] | undefined {
  const lists: (readonly string[])[] = [];
  for (const object of catalog.objects) {
    if (object.kind === "index") {
      if (object.identity.parent.name !== table) continue;
      if (object.definition.expression !== undefined) return undefined;
      lists.push(object.definition.columns);
    } else if (object.kind === "constraint") {
      if (object.identity.parent.name !== table) continue;
      const { constraintKind, columns } = object.definition;
      if (constraintKind === "primaryKey" || constraintKind === "unique") lists.push(columns);
    }
  }
  return lists;
}

function tenantColumns(schema: QuerySchema, model: TableModel): readonly string[] {
  const tenancy = schema.tenancy;
  if (tenancy === undefined) return [];
  const keys = tenancy.keys !== undefined && tenancy.keys.length > 0 ? tenancy.keys : [tenancy.key];
  const out: string[] = [];
  for (const column of model.columns) if (keys.includes(column.field)) out.push(column.sql);
  return out;
}

function covered(
  lists: readonly (readonly string[])[],
  columns: readonly string[],
  tenant: readonly string[],
): boolean {
  for (const list of lists) {
    if (startsWith(list, columns)) return true;
    let skip = 0;
    while (skip < list.length && tenant.includes(list[skip] as string)) skip += 1;
    if (skip > 0 && startsWith(list.slice(skip), columns)) return true;
  }
  return false;
}

function startsWith(list: readonly string[], columns: readonly string[]): boolean {
  return list.length >= columns.length && sameSet(list.slice(0, columns.length), columns);
}
