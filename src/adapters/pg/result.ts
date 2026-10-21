/**
 * Turns a driver result into wire rows.
 *
 * The empty notice list is shared. A call that received none does not allocate one.
 */

import type { ExecuteResult, Notice, WireValue } from "../../contracts/driver.js";

/** Shared notice list for a statement that received none. */
export const EMPTY_NOTICES: readonly Notice[] = [];

/**
 * Reads one cell as wire text.
 *
 * @param value - A driver cell
 * @returns Wire text, or `null` for SQL NULL
 */
export function cell(value: unknown): WireValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * Reads rows as arrays of wire text.
 *
 * @param value - A driver result, or its row list
 * @returns Wire rows
 */
export function rowsFrom(value: unknown): WireValue[][] {
  const list = rowList(value);
  const rows = Array.from<WireValue[]>({ length: list.length });
  for (let index = 0; index < list.length; index += 1) {
    rows[index] = rowCells(list[index]);
  }
  return rows;
}

/**
 * Builds an {@link ExecuteResult}.
 *
 * @param value - A driver result
 * @param notices - Notices observed during the call
 * @returns Rows, the caller count, the command-tag count, and notices
 */
export function resultFrom(value: unknown, notices: readonly Notice[]): ExecuteResult {
  const rows = rowsFrom(value);
  const reported = reportedFrom(value);
  return {
    rows,
    count: reported ?? rows.length,
    reported,
    notices,
  };
}

function rowList(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null && "rows" in value) {
    const rows: unknown = Reflect.get(value, "rows");
    if (Array.isArray(rows)) return rows;
  }
  return [];
}

function rowCells(row: unknown): WireValue[] {
  if (Array.isArray(row)) {
    const cells = Array.from<WireValue>({ length: row.length });
    for (let index = 0; index < row.length; index += 1) cells[index] = cell(row[index]);
    return cells;
  }
  if (typeof row === "object" && row !== null) {
    const values = Object.values(row);
    const cells = Array.from<WireValue>({ length: values.length });
    for (let index = 0; index < values.length; index += 1) cells[index] = cell(values[index]);
    return cells;
  }
  return [cell(row)];
}

/**
 * Command-tag count from the first own field a driver uses.
 *
 * Order is `count` (postgres.js, Bun.sql), `rowCount` (pg, Neon, PGlite),
 * then `affectedRows` (PGlite, only when `rowCount` is absent). An own field
 * that is not a finite number means the driver reported nothing: later fields
 * are not a fallback. PGlite's `affectedRows` is cumulative across statements
 * in one query; its `rowCount` is the per-statement tag.
 *
 * @param value - A driver result
 * @returns The tag count, or null when the driver gave none
 */
function reportedFrom(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  for (const name of ["count", "rowCount", "affectedRows"] as const) {
    if (!Object.hasOwn(value, name)) continue;
    const found: unknown = Reflect.get(value, name);
    if (typeof found === "number" && Number.isFinite(found)) return found;
    return null;
  }
  return null;
}
