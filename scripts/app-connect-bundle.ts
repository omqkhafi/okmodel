/**
 * Featureless connect app for the single-file bundle report.
 *
 * `connect` from `okmodel/pg/bun`, `schema()`, and one table. No other feature.
 * `scripts/size-report.ts` prints the minified file. It is not a gate (D365).
 */

import { schema, table, t } from "../src/dialects/pg/index.js";
import { connect } from "../src/runtime/pg/bun.js";

const users = table("users", { id: t.integer().primaryKey() });

/** Schema built when this module is imported. */
export const app = schema({ tables: [users] });

/**
 * Opens a client. Not called at import, so the measurement does not connect.
 *
 * @param url - Postgres connection string
 * @returns The connected client
 */
export function open(url: string) {
  return connect(url, { schema: app });
}
