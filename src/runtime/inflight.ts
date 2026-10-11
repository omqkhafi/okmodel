/**
 * Refuses a positive timeout on a driver that cannot cancel.
 *
 * `tx({ timeout })` and `batch({ timeout })` load this with the call. The
 * connect graph does not. The message stays the one {@link noTimeout} throws.
 */

import type { DriverPool } from "../contracts/driver.js";

/**
 * Throws OKM1120 when `timeout` is positive and the driver cannot cancel.
 *
 * @param pool - Driver the call will use
 * @param timeout - Milliseconds, when the caller passed one
 */
export async function refuseUncancellableTimeout(
  pool: DriverPool,
  timeout: number | undefined,
): Promise<void> {
  if (pool.capabilities.cancel === true || timeout === undefined || !(timeout > 0)) return;
  const { noTimeout } = await import("../adapters/pg/no-inflight-timeout.js");
  noTimeout({ timeout });
}
