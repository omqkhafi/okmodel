/**
 * Eight-client probe for {@link detectPooler} (B-41, D344).
 *
 * {@link resolvePooler} reads URL signals and `allowPooler` first and opens
 * no client. Eight clients run only when nothing matched and the caller still
 * has to decide. Each reads `pg_backend_pid()` a few times while the others
 * run. One stable pid per client is proven direct. A pid change, or fewer
 * backends than clients, is pooled. A stable idle pid on one session is not
 * a signal and is not proof of a direct connection.
 */

import { open } from "../../adapters/pg/postgresjs.js";
import { driverUrl } from "./driver-url.js";
import { detectPooler, type PoolerDetection } from "./pooler.js";

/** Clients opened together. */
const CONCURRENT_CLIENTS = 8;
/** Statements each client runs while the others run. */
const CONCURRENT_STATEMENTS = 3;

/**
 * Decides with the URL first, then eight clients when the URL did not.
 *
 * `allowPooler` is a config signal and skips the clients. A URL that already
 * matches a host, port, or `pgbouncer=true` does too. A quiet URL is not
 * direct until the clients prove it.
 *
 * @param url - Target URL. Not copied into the result
 * @param allowPooler - The invocation opted in
 * @returns The detector result
 */
export async function resolvePooler(url: string, allowPooler = false): Promise<PoolerDetection> {
  const hinted = detectPooler({ url, marker: allowPooler });
  if (hinted.pooled || allowPooler) return hinted;
  return probeConcurrent(url);
}

/**
 * Opens eight clients at once and reads `pg_backend_pid()` on each.
 *
 * Each client runs a few statements while the others run. A pid change on one
 * client, or fewer distinct backends than clients, is pooled. One stable pid
 * per client is proven direct. A URL that already matches a signal is returned
 * without opening a client. Prefer {@link resolvePooler} when `allowPooler`
 * can also skip the clients.
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
    const banner = await pools[0]?.execute("select version()");
    // PGlite is one process. Every connection reports the same pid, which is
    // not a transaction-mode pooler.
    if (String(banner?.rows[0]?.[0] ?? "").includes("PGlite")) return detectPooler({ url });
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
