/**
 * `onConflict` planning.
 *
 * Loaded only when a write passes `onConflict` other than `"error"`.
 * A plain insert does not import this module.
 */

import { throwNamed } from "../contracts/error.js";
import type { ColumnModel } from "../dialects/pg/model.js";
import { isRecord, fail, list, projectExpr, quote, type Indexed } from "./plan.js";

/** How a conflict should be written. `"error"` never reaches here. */
export type ConflictPlan = {
  readonly kind: "ignore" | "update" | "return";
  readonly columns: readonly ColumnModel[];
  readonly update: readonly ColumnModel[];
};

/**
 * Reads `onConflict` and checks `on` against unique constraints (OKM1104).
 *
 * @param table - Target table
 * @param value - The option the caller passed
 * @returns The plan, or `undefined` for the default `"error"`
 */
export function readConflict(table: Indexed, value: unknown): ConflictPlan | undefined {
  if (value === undefined || value === "error") return undefined;
  if (value === "ignore") return { kind: "ignore", columns: [], update: [] };
  if (!isRecord(value)) {
    fail(
      "OKM1120",
      'onConflict must be "error", "ignore", { on, update }, or { on, return: true }.',
    );
  }
  const keys = Object.keys(value);
  const update = value.update;
  const ret = value.return;
  if (update !== undefined && ret !== undefined) {
    fail("OKM1120", "onConflict takes update or return, not both.");
  }
  if (ret === true) {
    rejectConflictKeys(keys, ["on", "return"]);
    return { kind: "return", columns: uniqueColumns(table, value.on), update: [] };
  }
  if (update !== undefined) {
    rejectConflictKeys(keys, ["on", "update"]);
    return {
      kind: "update",
      columns: uniqueColumns(table, value.on),
      update: updateColumns(table, update),
    };
  }
  fail("OKM1120", 'onConflict must be "error", "ignore", { on, update }, or { on, return: true }.');
}

/**
 * Appends the conflict clause, or wraps a first-or-create insert.
 *
 * @param head - `insert into … values …` without `returning`
 * @param returning - ` returning …`, including the leading space
 * @param params - Insert parameters
 * @param plan - Conflict plan
 * @param table - Target table
 * @param returningColumns - Columns in `returning`
 * @param keys - Encoded conflict-key tuples, one per inserted row. Used by `return`
 * @returns Statement text and parameters
 */
export function finishInsert(
  head: string,
  returning: string,
  params: readonly (string | null)[],
  plan: ConflictPlan,
  table: Indexed,
  returningColumns: readonly ColumnModel[],
  keys: readonly (readonly (string | null)[])[],
): { readonly text: string; readonly params: (string | null)[] } {
  if (plan.kind === "ignore") {
    return { text: `${head} on conflict do nothing${returning}`, params: [...params] };
  }
  const target = plan.columns.map((column) => quote(column.sql)).join(", ");
  if (plan.kind === "update") {
    const set = plan.update
      .map((column) => `${quote(column.sql)} = excluded.${quote(column.sql)}`)
      .join(", ");
    return {
      text: `${head} on conflict (${target}) do update set ${set}${returning}`,
      params: [...params],
    };
  }
  return firstOrCreate(head, returning, params, plan.columns, table, returningColumns, keys);
}

function firstOrCreate(
  head: string,
  returning: string,
  params: readonly (string | null)[],
  keys: readonly ColumnModel[],
  table: Indexed,
  returningColumns: readonly ColumnModel[],
  keyRows: readonly (readonly (string | null)[])[],
): { readonly text: string; readonly params: (string | null)[] } {
  const next = [...params];
  const tuples: string[] = [];
  for (const row of keyRows) {
    const slots: string[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const column = keys[index];
      if (column === undefined) continue;
      next.push(row[index] ?? null);
      slots.push(`$${String(next.length)}::${column.dataType}`);
    }
    tuples.push(keys.length === 1 ? (slots[0] ?? "null") : `(${slots.join(", ")})`);
  }
  const keyList = keys.map((column) => quote(column.sql)).join(", ");
  const left =
    keys.length === 1
      ? `t.${quote(keys[0]?.sql ?? "")}`
      : `(${keys.map((column) => `t.${quote(column.sql)}`).join(", ")})`;
  const names = returningColumns.map((column) => quote(column.field)).join(", ");
  const fromTable = returningColumns
    .map((column) => projectExpr(`t.${quote(column.sql)}`, column.dataType))
    .join(", ");
  const match = keys
    .map((column) => `ins.${quote(column.field)} = t.${quote(column.sql)}`)
    .join(" and ");
  const text = `with ins(${names}) as (${head} on conflict (${keyList}) do nothing${returning}) select ${names} from ins union all select ${fromTable} from ${quote(table.model.sql)} t where ${left} in (${tuples.join(", ")}) and not exists (select 1 from ins where ${match})`;
  return { text, params: next };
}

function uniqueColumns(table: Indexed, on: unknown): readonly ColumnModel[] {
  const names = conflictNames(on);
  for (const unique of table.model.uniques) {
    if (!same(unique, names)) continue;
    const columns: ColumnModel[] = [];
    for (const name of names) {
      const column = table.columns.get(name);
      if (column === undefined) {
        fail("OKM1104", `onConflict column ${name} is not on ${table.model.name}.`);
      }
      columns.push(column);
    }
    return columns;
  }
  const accepted = table.model.uniques.map((fields) => fields.join(", "));
  throwNamed(
    "OKM1104",
    names.join(", "),
    accepted,
    `onConflict on ${table.model.name} names ${names.join(", ")}, which is not a unique constraint. Accepted: ${list(accepted)}.`,
  );
}

function updateColumns(table: Indexed, value: unknown): readonly ColumnModel[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("OKM1120", "onConflict update must name at least one column.");
  }
  const columns: ColumnModel[] = [];
  for (const name of value) {
    if (typeof name !== "string") fail("OKM1120", "onConflict update must name columns.");
    const column = table.columns.get(name);
    if (column === undefined) {
      throwNamed(
        "OKM1120",
        name,
        table.names,
        `Field ${name} is not on ${table.model.name}. Accepted names: ${list(table.names)}.`,
      );
    }
    if (!column.writable) refuseWrite(table.model.name, column);
    columns.push(column);
  }
  return columns;
}

function conflictNames(on: unknown): readonly string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on) && on.length > 0 && on.every((name) => typeof name === "string")) {
    return on as readonly string[];
  }
  fail("OKM1104", "onConflict on must name a unique constraint's columns.");
}

function same(unique: readonly string[], names: readonly string[]): boolean {
  if (unique.length !== names.length) return false;
  const left = [...unique].sort();
  const right = [...names].sort();
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function rejectConflictKeys(keys: readonly string[], accepted: readonly string[]): void {
  for (const key of keys) {
    if (!accepted.includes(key)) {
      throwNamed(
        "OKM1120",
        key,
        accepted,
        `Option ${key} is not accepted by onConflict. Accepted options: ${list(accepted)}.`,
      );
    }
  }
}

function refuseWrite(table: string, column: ColumnModel): never {
  if (column.guarded) {
    fail("OKM1190", `Field ${table}.${column.field} is guarded. Input cannot set it.`);
  }
  fail("OKM1120", `Field ${table}.${column.field} cannot be written.`);
}
