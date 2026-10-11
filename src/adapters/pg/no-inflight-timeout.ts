/**
 * Refusal for a driver that cannot cancel an in-flight statement (D224).
 *
 * Bun.sql and PGlite throw OKM1120 for a positive `timeout`. The message
 * stays `timeout` because the PGlite connect graph has two gzip bytes left.
 * Kind is `invalid`, which separates it from kind `timeout`. `timeout: 0`
 * still fails immediately as kind `timeout`. `signal` is unchanged.
 * postgres.js and node-postgres do not import this.
 */

import { OkmError } from "../../contracts/error.js";

/**
 * Throws OKM1120 when `timeout` is a positive number.
 *
 * @param options - Per-call options. Absent, and a non-positive timeout, pass through
 */
export function noTimeout(options: { readonly timeout?: number } | undefined): void {
  if ((options?.timeout ?? 0) <= 0) return;
  throw new OkmError("OKM1120", "timeout");
}
