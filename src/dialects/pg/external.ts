/**
 * A table owned by another catalog.
 *
 * The mark is the same one `withOwner(..., "external")` stores. `schema()`
 * does not read it. Tooling stamps the catalog and, when `defineConfig`
 * names a snapshot, keeps this table's namespace and name from that file.
 */

import type { AnyTable } from "./table.js";
import { withOwner } from "./owner.js";

/**
 * Turns a table exported by another catalog into an external definition.
 *
 * The table object is the same value: its name and columns stay. SQL for a
 * managed foreign key is schema-qualified. A plan never creates, alters, or
 * drops this table. `okm check` verifies it against the snapshot.
 *
 * @param table - A `table()` value declared by the owning catalog
 * @returns The same table, marked external
 */
export function external<T extends AnyTable>(table: T): T {
  return withOwner(table, "external");
}
