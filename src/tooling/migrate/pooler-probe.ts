/**
 * Warm-and-hold pid probe for transaction-mode poolers.
 *
 * Two back-to-back reads miss a default PgBouncer (`server_round_robin=0`):
 * LIFO hands the same backend back every time. Warming two backends and
 * holding one between reads forces a second pid when a pooler is present.
 * A direct session keeps one pid for all eight reads.
 */

import { open } from "../../adapters/pg/postgresjs.js";
import { driverUrl } from "../../adapters/pg/url.js";
import { assertStableBackend } from "./policy.js";

/**
 * Refuses a session whose backend pid changes across eight reads.
 *
 * When `allowPooler` is false, warms two backends on `url` and holds one
 * between reads so a LIFO pooler cannot reuse a single server.
 *
 * @param url - Target URL (pooler hints are stripped for the disruptor)
 * @param readPid - Reads `pg_backend_pid()` on the session under test
 * @param allowPooler - The invocation opted in
 */
export async function probeStableBackend(
  url: string,
  readPid: () => Promise<string>,
  allowPooler: boolean,
): Promise<void> {
  if (allowPooler) return;
  const cleaned = driverUrl(url);
  await warmTwoBackends(cleaned);
  const disrupt = open({ url: cleaned, max: 1 });
  try {
    if (disrupt.reserve === undefined) {
      await assertStableBackend(readPid, false);
      return;
    }
    await assertStableBackend(readPid, false, {
      holdBackend: async () => {
        const held = await disrupt.reserve!();
        await held.execute("begin");
        return async () => {
          await held.execute("rollback").catch(() => undefined);
          await held.release();
        };
      },
    });
  } finally {
    await disrupt.close();
  }
}

async function warmTwoBackends(url: string): Promise<void> {
  const first = open({ url, max: 1 });
  const second = open({ url, max: 1 });
  try {
    await Promise.all([
      first.execute("select pg_sleep(0.25)"),
      second.execute("select pg_sleep(0.25)"),
    ]);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
}
