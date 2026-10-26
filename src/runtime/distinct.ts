/**
 * `distinct` and Postgres `distinctOn` on `find` (spec section 10).
 *
 * `distinct: true` keeps one row per different combination of the selected
 * fields. `distinctOn: [fields]` keeps the first row of each key under
 * `orderBy`, which must start with the same keys. Postgres is the only dialect
 * with `distinct on`. Loaded on the first `find` that names either option, so
 * a plain `find` never pays for it.
 *
 * The statement is the one a window read writes. `select distinct` may only
 * order by a selected value, so that order goes by select position: a
 * timestamp is selected as text and an `order by` on the column would not
 * match it. `distinct on` orders by the column, because its keys must match
 * the order expressions exactly.
 */

import { OkmError, throwNamed } from "../contracts/error.js";
import type { ColumnModel } from "../dialects/pg/model.js";
import { attachHttp, decodeRows, readCall, readHandle, type Mods, type Session } from "./client.js";
import {
  fail,
  indexes,
  isRecord,
  list,
  orderNamesRelation,
  quote,
  refuseHidden,
  selectedColumns,
  type ArchiveView,
  type Indexed,
  type Sink,
} from "./plan.js";
import { statement } from "./window.js";

/**
 * Builds the handle for one `find` with `distinct` or `distinctOn`.
 *
 * @param session - Client session
 * @param table - Table name
 * @param options - `find` options plus `distinct` or `distinctOn`
 * @param mods - `.all` reason and presets
 * @param view - Archive visibility
 * @returns A handle that resolves to the distinct rows
 */
export function build(
  session: Session,
  table: string,
  options: object,
  mods: Mods,
  view: ArchiveView | undefined,
): Promise<unknown> & Record<string, unknown> {
  try {
    return plan(session, table, options, mods, view);
  } catch (error) {
    throw error instanceof OkmError ? attachHttp(session.http, error) : error;
  }
}

function plan(
  session: Session,
  table: string,
  options: object,
  mods: Mods,
  view: ArchiveView | undefined,
): Promise<unknown> & Record<string, unknown> {
  const { distinct, distinctOn, ...rest } = options as Record<string, unknown>;
  const indexed = indexes(session.schema).get(table);
  if (indexed === undefined) fail("OKM1120", `Table ${table} is not in the schema.`);
  if (distinct !== undefined && distinct !== true) {
    fail(
      "OKM1120",
      "distinct is true when you want distinct rows.",
      "Pass distinct: true, or distinctOn: [fields] for the first row of each key.",
    );
  }
  if (distinct !== undefined && distinctOn !== undefined) {
    fail("OKM1120", "Pass distinct or distinctOn, not both.");
  }
  if (rest.include !== undefined || rest.search !== undefined) {
    fail("OKM1120", "distinct and distinctOn do not take include or search.");
  }
  if (orderNamesRelation(indexed, rest.orderBy)) {
    const on = distinctOn !== undefined;
    fail(
      "OKM1127",
      on
        ? "orderBy on a relation is not available with distinctOn."
        : "orderBy on a relation is not available with distinct.",
      on
        ? "Order by a column of this table, or drop distinctOn."
        : "Order by a column of this table, or drop distinct.",
    );
  }
  const keys = distinctOn === undefined ? undefined : onKeys(indexed, distinctOn);
  const columns = selectedColumns(indexed, rest.select);
  const ordinals = new Map<string, string>();
  if (keys === undefined) {
    if (rest.select === undefined || columns.length === 0) {
      fail(
        "OKM1120",
        "distinct needs select. Without it every row differs by its primary key.",
        'Pass select: ["field"], or distinctOn: ["field"] for the first row of each key.',
      );
    }
    const names = columns.map((column) => column.field);
    for (const field of isRecord(rest.orderBy) ? Object.keys(rest.orderBy) : []) {
      if (!names.includes(field)) {
        fail(
          "OKM1120",
          `distinct orders by a selected field. ${field} is not in select. Selected: ${list(names)}.`,
          "Add the field to select, or use distinctOn.",
        );
      }
    }
    for (const [index, name] of names.entries()) ordinals.set(name, String(index + 1));
  } else {
    leadingOrder(rest.orderBy, keys);
  }
  const head = (sink: Sink): void => {
    if (keys === undefined) {
      sink.text("distinct ");
      sink.mark("distinct|");
      return;
    }
    sink.text(`distinct on (${keys.map((key) => `t.${quote(key.sql)}`).join(", ")}) `);
    sink.mark(`on:${keys.map((key) => key.field).join(",")}|`);
  };
  const call = {
    ...readCall(
      "find",
      table,
      rest,
      mods.all,
      session.scope,
      session.schema.model[table],
      session.schema,
      view,
    ),
    build: statement(
      { items: columns.map((column) => ({ kind: "column", column })), ordinals },
      head,
    ),
  };
  return readHandle(session, table, call, mods, (compiled, rows) =>
    decodeRows(compiled, rows, table),
  );
}

/** The `distinctOn` fields as columns. Each is a visible field of the table, once. */
function onKeys(table: Indexed, value: unknown): readonly ColumnModel[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("OKM1120", "distinctOn must be a list of field names.", 'Pass distinctOn: ["field"].');
  }
  const keys: ColumnModel[] = [];
  for (const name of value) {
    const column = typeof name === "string" ? table.columns.get(name) : undefined;
    if (typeof name !== "string" || column === undefined) {
      throwNamed(
        "OKM1120",
        String(name),
        table.names,
        `Field ${String(name)} is not on ${table.model.name}. Accepted names: ${list(table.names)}.`,
      );
    }
    refuseHidden(column);
    if (keys.includes(column)) fail("OKM1120", `distinctOn names ${name} twice.`);
    keys.push(column);
  }
  return keys;
}

/** `distinctOn` keeps the first row of each key, so `orderBy` must open with those keys. */
function leadingOrder(orderBy: unknown, keys: readonly ColumnModel[]): void {
  const names = keys.map((key) => key.field);
  const lead = isRecord(orderBy) ? Object.keys(orderBy).slice(0, names.length) : [];
  if (lead.length < names.length || lead.some((field) => !names.includes(field))) {
    fail(
      "OKM1120",
      `distinctOn needs an orderBy that starts with ${list(names)}.`,
      `Pass orderBy: { ${names.map((name) => `${name}: "asc"`).join(", ")}, ... }. The keys after those pick the row each key keeps.`,
    );
  }
}
