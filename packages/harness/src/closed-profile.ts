/**
 * Test-only dialect profile that refuses every Postgres feature.
 *
 * Nothing under `src/` imports this file. The runtime entry and the
 * featureless app do not see it. Adapter flags are all off. `prepared` and
 * `describe` are not flags on `DriverCapabilities`.
 */

import { DriverError } from "../../../src/adapters/error.js";
import type {
  DriverCapabilities,
  DriverPool,
  ExecuteResult,
} from "../../../src/contracts/driver.js";
import { POSTGRES_FEATURES } from "../../../src/tooling/capabilities/postgres.js";
import type { FeatureEntry, Registry } from "../../../src/tooling/capabilities/types.js";

const EMPTY: ExecuteResult = { rows: [], count: 0, notices: [] };
const VERSION: ExecuteResult = {
  rows: [["170000", "PostgreSQL 17.0", null]],
  count: 1,
  notices: [],
};

/**
 * Adapter flags for the profile. Every boolean flag is false.
 * Transactions are `"none"`.
 */
export const CLOSED_CAPABILITIES = {
  transactions: "none",
  stream: false,
  listen: false,
  cancel: false,
} as const satisfies DriverCapabilities;

/**
 * Postgres keys, each marked refused.
 *
 * The code is OKM1860 because that is the code `assertSupported` raises.
 * The alternative names the key so a case can tell entries apart.
 *
 * @returns A registry whose every entry is refused
 */
/** Most restrictive cost for observer keys that have a cost scale. */
const CLOSED_COST: Readonly<Record<string, string>> = {
  "writeObserver.keys": "none",
  "writeObserver.rowCount": "unknown",
  "queryObserver.timing": "none",
};

export function closedRegistry(): Registry {
  const registry: Record<string, FeatureEntry> = {};
  for (const [key, entry] of Object.entries(POSTGRES_FEATURES)) {
    const cost = CLOSED_COST[key];
    registry[key] = {
      support: "refused",
      proof: entry.proof,
      code: "OKM1860",
      alternative: `Portable substitute for ${key}.`,
      ...(entry.since !== undefined ? { since: entry.since } : {}),
      ...(entry.gate !== undefined ? { gate: entry.gate } : {}),
      ...(cost !== undefined ? { cost } : {}),
    };
  }
  return registry;
}

/**
 * Opens an in-memory pool for the portable minimum.
 *
 * The first startup query returns a Postgres 17 version row and a null
 * catalog hash. `insert into … values ($1, $2)` stores one row. A second
 * insert of the same id is a unique violation. `select` with `$1` reads it
 * back. `select 1` returns one row. There is no `describe`, `stream`,
 * `listen`, `reserve`, or `cancel`.
 *
 * @returns A pool the caller closes
 */
export function openClosedDriver(): DriverPool {
  const rows = new Map<string, string | null>();
  let open = true;
  return {
    capabilities: CLOSED_CAPABILITIES,
    execute(text, params) {
      if (!open)
        return Promise.reject(new DriverError("The pool is closed.", { sqlstate: "08006" }));
      const sql = text.trim().toLowerCase();
      if (sql.includes("server_version_num")) return Promise.resolve(VERSION);
      if (sql.startsWith("insert")) {
        const id = params?.[0] ?? "";
        if (rows.has(id)) {
          return Promise.reject(
            new DriverError("duplicate key value violates unique constraint", {
              sqlstate: "23505",
              constraint: "notes_pkey",
              table: "notes",
            }),
          );
        }
        rows.set(id, params?.[1] ?? null);
        return Promise.resolve({ rows: [], count: 1, notices: [] });
      }
      if (sql.startsWith("select")) {
        const id = params?.[0];
        if (typeof id === "string" && rows.has(id)) {
          return Promise.resolve({ rows: [[rows.get(id) ?? null]], count: 1, notices: [] });
        }
        if (sql.startsWith("select 1"))
          return Promise.resolve({ rows: [["1"]], count: 1, notices: [] });
        return Promise.resolve(EMPTY);
      }
      return Promise.resolve(EMPTY);
    },
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: open ? 1 : 0, inflight: 0, waiting: 0 }),
    close() {
      open = false;
      return Promise.resolve();
    },
  };
}
