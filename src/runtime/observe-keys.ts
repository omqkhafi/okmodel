/**
 * Opt-in primary keys for `writeObserver({ keys })`.
 *
 * Loaded at connect when keys are set, and again when a write is planned.
 * A table with no primary key cannot opt in (OKM1890).
 */

import { OkmError } from "../contracts/error.js";
import type { QuerySchema } from "../dialects/pg/model.js";

/**
 * Tables named on a `writeObserver({ keys })` handler.
 *
 * @param handler - `connect({ onWrite })` value, which may carry `observeKeys`
 * @returns The table list, or `undefined` when keys were not requested
 */
export function observeKeyList(handler: object | undefined): readonly string[] | undefined {
  if (handler === undefined || !("observeKeys" in handler)) return undefined;
  const keys: unknown = handler.observeKeys;
  return Array.isArray(keys) && keys.length > 0 ? (keys as readonly string[]) : undefined;
}

/**
 * Refuses a key list that names a missing table or a table with no primary key.
 *
 * @param schema - Connected schema
 * @param keys - Table names from `writeObserver({ keys })`
 */
export function assertObserveKeys(schema: QuerySchema, keys: readonly string[]): void {
  for (const name of keys) {
    const model = schema.model[name];
    if (model === undefined) {
      throw new OkmError(
        "OKM1890",
        `writeObserver keys cannot include ${name}: the table is not in the schema.`,
        {
          kind: "invalid",
          table: name,
          fix: {
            summary: `Remove ${name} from writeObserver({ keys }), or add that table to the schema.`,
          },
        },
      );
    }
    if (model.primary.length === 0) {
      throw new OkmError(
        "OKM1890",
        `writeObserver keys cannot include ${name}: the table has no primary key.`,
        {
          kind: "invalid",
          table: name,
          fix: {
            summary: `Add a primary key on ${name}, or remove it from writeObserver({ keys }).`,
          },
        },
      );
    }
  }
}
