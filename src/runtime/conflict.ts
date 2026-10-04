/**
 * `onConflict` planning.
 *
 * Loaded only when a write passes `onConflict` other than `"error"`.
 * A plain insert does not import this module.
 */

import { throwNamed } from "../contracts/error.js";
import type { ColumnModel } from "../dialects/pg/model.js";
import { isRecord, fail, list, projectExpr, quote, type Indexed } from "./plan.js";
import { fieldSealed, touchFields } from "./trait-read.js";

/** How a conflict should be written. `"error"` never reaches here. */
export type ConflictPlan = {
  readonly kind: "ignore" | "update" | "return";
  readonly columns: readonly ColumnModel[];
  readonly update: readonly ColumnModel[];
};

const NO_ALLOW: ReadonlySet<string> = new Set();

/**
 * Reads `onConflict` and checks `on` against unique constraints (OKM1104).
 *
 * @param table - Target table
 * @param value - The option the caller passed
 * @param allow - Guarded fields this write may set
 * @returns The plan, or `undefined` for the default `"error"`
 */
export function readConflict(
  table: Indexed,
  value: unknown,
  allow: ReadonlySet<string> = NO_ALLOW,
): ConflictPlan | undefined {
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
      update: updateColumns(table, update, allow),
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
    const assignments = plan.update.map(
      (column) => `${quote(column.sql)} = excluded.${quote(column.sql)}`,
    );
    const touch = touchFields(table.model);
    if (touch !== undefined) {
      for (const field of touch) {
        const column = table.columns.get(field);
        if (column !== undefined) assignments.push(`${quote(column.sql)} = now()`);
      }
    }
    return {
      text: `${head} on conflict (${target}) do update set ${assignments.join(", ")}${returning}`,
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

function updateColumns(
  table: Indexed,
  value: unknown,
  allow: ReadonlySet<string>,
): readonly ColumnModel[] {
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
    if (
      fieldSealed(table.model, name) ||
      column.guardUpdate ||
      (!column.writable && !(column.guarded && allow.has(name)))
    ) {
      refuseWrite(table, column);
    }
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

function refuseWrite(table: Indexed, column: ColumnModel): never {
  if (fieldSealed(table.model, column.field)) {
    fail(
      "OKM1190",
      `Field ${table.model.name}.${column.field} is set by a trait. Input cannot set it.`,
    );
  }
  if (column.guardUpdate) {
    fail(
      "OKM1190",
      `Field ${table.model.name}.${column.field} is a primary key. Input cannot change it.`,
    );
  }
  if (column.guarded) {
    fail("OKM1190", `Field ${table.model.name}.${column.field} is guarded. Input cannot set it.`);
  }
  fail("OKM1120", `Field ${table.model.name}.${column.field} cannot be written.`);
}
