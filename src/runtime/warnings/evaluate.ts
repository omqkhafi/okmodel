/**
 * Static warning checks.
 *
 * Each rule reads the planned read. Nothing here asks the database or the
 * write observer.
 */

import { isOperator, operatorName, operatorValue } from "../../dialects/pg/operators.js";
import type { QuerySchema, RelationModel, TableModel } from "../../dialects/pg/model.js";
import type { IncludeOut, ReadDone } from "../plan.js";
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
  /** Key and value of the root default `connect({ limits })` applied. */
  readonly dl?: readonly [key: string, value: number];
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
  return false;
}

/**
 * Names the defaults whose row count equals the default.
 *
 * `page()` is left out: it returns a cursor, so a full page is not a cut-off.
 * An include counts when any parent got exactly the default.
 */
function defaultReached(call: WarningCall, done: ReadDone | undefined): false | string {
  if (done === undefined) return false;
  const rows = rowsOf(done.value);
  const found: string[] = [];
  const root = call.dl;
  if (root !== undefined && root[0] !== "page" && rows.length === root[1]) {
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
  return !endsWithUnique(call.orderBy, table.uniques);
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
