/**
 * Marks the table a path ends on.
 *
 * The symbol lives here so a column-only app and a featureless app do not
 * load it. `archivable()` reads it. Compile hashes named fields, so the mark
 * stays out of the catalog.
 */

/**
 * Property set on the tenant table a path ends on.
 *
 * An options spread does not copy it. The rewrite sets it on the table object.
 */
export const pathEndpoint: unique symbol = Symbol("okmodel.pathEndpoint");

/**
 * Records that `table` is the end of a path.
 *
 * @param table - The rewritten tenant table
 * @returns The same table, marked
 */
export function markPathEndpoint<T extends object>(table: T): T {
  return Object.assign(table, { [pathEndpoint]: true });
}
