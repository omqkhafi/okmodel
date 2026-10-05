/**
 * Calls the observers of `connect({ hookm })`.
 *
 * Hookm are events only (spec §18). An error a hook throws is dropped, so an
 * observer never changes a query, a commit, or a rollback. Loaded when a hook
 * is set and an event happens.
 */

import type { Notice } from "../contracts/driver.js";
import type { Hookm, TransactionEvent } from "./types.js";

/**
 * Tells every `onNotice` about server notices, in order.
 *
 * @param hookm - Observers from `connect`
 * @param notices - Notices a statement returned
 */
export function notices(hookm: readonly Hookm[] | undefined, notices: readonly Notice[]): void {
  if (hookm === undefined) return;
  for (const notice of notices) {
    for (const hook of hookm) call(() => hook.onNotice?.(notice));
  }
}

/**
 * Tells every `onTransaction` that a transaction or savepoint changed phase.
 *
 * @param hookm - Observers from `connect`
 * @param phase - `start`, `commit`, or `rollback`
 * @param depth - 0 for the transaction, 1 and up for savepoints
 */
export function phase(
  hookm: readonly Hookm[] | undefined,
  phase: TransactionEvent["phase"],
  depth: number,
): void {
  if (hookm === undefined) return;
  const event: TransactionEvent = { phase, depth };
  for (const hook of hookm) call(() => hook.onTransaction?.(event));
}

/**
 * Gives an error no caller can receive to every `onError` and to the logger.
 *
 * @param session - Observers and the logger from `connect`
 * @param error - What failed, for example an `afterCommit` callback
 */
export function report(
  session: {
    readonly hookm: readonly Hookm[] | undefined;
    readonly logger:
      | { error?(entry: { readonly code: string; readonly summary: string }): void }
      | undefined;
  },
  error: unknown,
): void {
  for (const hook of session.hookm ?? []) call(() => hook.onError?.(error));
  const entry =
    error instanceof Error
      ? { code: "code" in error ? String(error.code) : error.name, summary: error.message }
      : { code: "error", summary: String(error) };
  call(() => session.logger?.error?.(entry));
}

function call(fn: () => void): void {
  try {
    fn();
  } catch {
    // An observer cannot change what it observes.
  }
}
