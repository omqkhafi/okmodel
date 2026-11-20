/**
 * Column type checks `aggregate`, `runningTotal`, and `computed` share.
 *
 * Loaded by those lazy chunks. The startup graph does not import it.
 */

import type { ColumnModel } from "../dialects/pg/model.js";
import { fail } from "./plan.js";

/** Column types `sum` and `avg` take. */
export const NUMERIC = /^(smallint|integer|bigint|real|double precision|numeric|decimal)\b/;

/** Column types with no order, so `min` and `max` refuse them. */
export const UNORDERED = /^(json|jsonb|bytea|point|line|tsvector)\b|\[\]$/;

/**
 * Names the JavaScript type a numeric column reads as: `number`, `string`, or another.
 *
 * @param column - A numeric column
 * @returns `typeof` the value its codec gives for `"0"`
 */
export function readsAs(column: ColumnModel): string {
  return typeof (column.decode?.("0") ?? "");
}

/**
 * Encodes a count, sum, or avg operand: a finite number or a numeric string.
 *
 * @param value - The caller's operand
 * @returns The wire text
 */
export function numberText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return value;
  return fail("OKM1121", "A count, sum, or avg compares with a number or a numeric string.");
}
