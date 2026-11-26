/**
 * Pid probe for transaction-mode poolers (B-41).
 *
 * Eight separate `pg_backend_pid()` reads on the caller's session. Two or
 * more distinct pids mean a pooler handed out a new backend. A direct
 * session keeps one pid. A rotating pooler (`server_round_robin=1`) is
 * refused on any port. Default LIFO PgBouncer on a non-heuristic port can
 * keep one pid for all eight reads; mark that URL with `?pgbouncer=true`
 * (or a `pooler` / `pgbouncer` host) so the URL guard refuses it.
 *
 * Warm-and-hold for LIFO needs extra connections and deadlocks a
 * single-connection target (PGlite wire) when apply/seed already hold
 * `max: 1`. That path stays in the PgBouncer test via the optional
 * `holdBackend` option; production keeps URL heuristics plus these eight
 * reads.
 */

import { open } from "../../adapters/pg/postgresjs.js";
import { driverUrl } from "./driver-url.js";
import {
  detectPooler,
  probePooler,
  type PoolerDetection,
  type StableBackendOptions,
} from "./pooler.js";

/** Clients opened together. */
const CONCURRENT_CLIENTS = 8;
/** Statements each client runs while the others run. */
const CONCURRENT_STATEMENTS = 3;

/**
 * Opens eight clients at once and reads `pg_backend_pid()` on each.
 *
 * Each client runs a few statements while the others run. A pid change on one
 * client, or fewer distinct backends than clients, is pooled. One stable pid
 * per client is proven direct. A URL that already matches a signal is returned
 * without opening a client.
 *
 * @param url - Target URL. Not copied into the result
 * @returns The detector result
 */
export async function probeConcurrent(url: string): Promise<PoolerDetection> {
  const hinted = detectPooler({ url });
  if (hinted.pooled) return hinted;
  const pools = Array.from({ length: CONCURRENT_CLIENTS }, () =>
    open({ url: driverUrl(url), max: 1 }),
  );
  try {
    const sets = await Promise.all(
      pools.map(async (pool) => {
        const seen = new Set<string>();
        for (let i = 0; i < CONCURRENT_STATEMENTS; i += 1) {
          const result = await pool.execute("select pg_backend_pid()::text");
          const pid = String(result.rows[0]?.[0] ?? "");
          if (pid.length > 0) seen.add(pid);
        }
        return seen;
      }),
    );
    const distinct = new Set(sets.flatMap((set) => [...set]));
    return detectPooler({
      url,
      concurrent: {
        clients: CONCURRENT_CLIENTS,
        distinct: distinct.size,
        changed: sets.some((set) => set.size > 1),
      },
    });
  } finally {
    await Promise.all(pools.map((pool) => pool.close().catch(() => undefined)));
  }
}

/**
 * Refuses a session whose backend pid changes across eight reads.
 *
 * @param _url - Target URL (unused; kept for call-site stability)
 * @param readPid - Reads `pg_backend_pid()` on the session under test
 * @param allowPooler - The invocation opted in
 * @param options - Optional hold between reads (PgBouncer tests)
 */
export async function probeStableBackend(
  url: string,
  readPid: () => Promise<string>,
  allowPooler: boolean,
  options?: StableBackendOptions,
): Promise<void> {
  await probePooler(url, readPid, allowPooler, options);
}
