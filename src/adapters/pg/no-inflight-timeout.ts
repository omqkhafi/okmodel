/**
 * Refusal for a driver that cannot cancel an in-flight statement (D224).
 *
 * Bun.sql and PGlite refuse a positive `timeout`. The OKM1120 text loads with
 * the lazy error module, so a connect entry does not carry it. Kind is
 * `invalid`, which separates it from kind `timeout`. `timeout: 0` still fails
 * immediately as kind `timeout`. `signal` is unchanged. postgres.js and
 * node-postgres do not import this.
 */

import { rejectUncancellable } from "../failure.js";

/**
 * Returns a rejected OKM1120 when `timeout` is a positive number.
 *
 * Absent, and a non-positive timeout, return `undefined` so the caller runs.
 *
 * @param options - Per-call options
 * @returns A rejected promise, or `undefined` when the call may run
 */
export function noTimeout(
  options: { readonly timeout?: number } | undefined,
): Promise<never> | undefined {
  if ((options?.timeout ?? 0) <= 0) return;
  return rejectUncancellable();
}
