/**
 * Index tails for extension operator classes.
 *
 * The catalog index stores `using …`. The core index factory does not grow a
 * `using` field. `pg_trgm` and the generated packs share this helper.
 */

import type { IndexCall } from "../table.js";

/**
 * Quotes one identifier the extension wrote, not a caller string from SQL.
 *
 * @param name - Identifier
 * @returns A double-quoted identifier
 */
export function quotedIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * An index call whose expression is a `using` tail.
 *
 * @param column - SQL column name
 * @param method - Index method, such as `gin` or `gist`
 * @param opclass - Operator class, such as `gin_trgm_ops`
 * @returns The index call
 */
export function usingIndex(column: string, method: string, opclass: string): IndexCall {
  const call: IndexCall = {
    columns: [column],
    isUnique: false,
    expression: `using ${method} (${quotedIdent(column)} ${opclass})`,
    unique() {
      return call;
    },
  };
  return call;
}
