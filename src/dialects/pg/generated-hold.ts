/**
 * Holds a generated expression until tooling prints it.
 *
 * `sql` text is stored as written. An expression or a where object is kept
 * in {@link heldGenerated} and the catalog stores `#` plus the index.
 */

import { heldIndex, heldToken } from "../../contracts/catalog/held.js";
import type { ColumnHandle } from "./table.js";

/** One held value and the field-to-SQL map that prints it. */
export const heldGenerated: {
  value: unknown;
  names: (field: string) => string;
}[] = [];

/**
 * Reports whether `expression` is still a placeholder.
 *
 * @param expression - Catalog generated expression
 * @returns `true` when tooling has not printed it yet
 */
export function isHeldExpression(expression: string): boolean {
  return heldIndex(expression) !== undefined;
}

/**
 * Turns a generated callback into catalog text.
 *
 * @param build - Callback `.generated()` stored
 * @param columns - Column handles
 * @param names - Field name to SQL name
 * @returns SQL text, or `#` plus an index into {@link heldGenerated}
 */
export function holdGenerated(
  build: (columns: Readonly<Record<string, ColumnHandle>>) => unknown,
  columns: Readonly<Record<string, ColumnHandle>>,
  names: (field: string) => string,
): string {
  const value = build(columns);
  const text = (value as { readonly text?: unknown; readonly name?: unknown } | null)?.text;
  if (typeof text === "string" && (value as { readonly name?: unknown }).name === undefined) {
    return text;
  }
  const id = heldGenerated.length;
  heldGenerated.push({ value, names });
  return heldToken(id);
}
