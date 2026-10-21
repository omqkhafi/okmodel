/**
 * The unvalidated NOT NULL mark on a column.
 *
 * Kept out of {@link column} so a schema that never reads a database does
 * not carry it. Introspection and the document reader are the only callers.
 */

import type { ColumnObject } from "./types.js";

/**
 * Records that a NOT NULL column's constraint is not validated.
 *
 * PostgreSQL 18 only. The column stays NOT NULL (`nullable` is false); the
 * mark says rows with NULL may still exist.
 *
 * @param source - A column built by {@link column}
 * @param constraint - Name of the `NOT VALID` NOT NULL constraint
 * @returns The same column with `definition.unvalidatedNotNull` set. A nullable column is returned unchanged
 */
export function withUnvalidatedNotNull(source: ColumnObject, constraint: string): ColumnObject {
  if (source.definition.nullable || constraint.length === 0) return source;
  return { ...source, definition: { ...source.definition, unvalidatedNotNull: constraint } };
}
