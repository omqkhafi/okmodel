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

import { assertStableBackend, type StableBackendOptions } from "./policy.js";

/**
 * Refuses a session whose backend pid changes across eight reads.
 *
 * @param _url - Target URL (unused; kept for call-site stability)
 * @param readPid - Reads `pg_backend_pid()` on the session under test
 * @param allowPooler - The invocation opted in
 * @param options - Optional hold between reads (PgBouncer tests)
 */
export async function probeStableBackend(
  _url: string,
  readPid: () => Promise<string>,
  allowPooler: boolean,
  options?: StableBackendOptions,
): Promise<void> {
  await assertStableBackend(readPid, allowPooler, options);
}
