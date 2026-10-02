/**
 * One deadline for a call.
 *
 * Created only when the caller passed `signal` or `timeout`. A plain execute
 * does not allocate one.
 */

import type { DriverFailureKind, ExecuteOptions } from "../../contracts/driver.js";
import { rejectCancelled, rejectClosed, rejectTimedOut } from "../failure.js";

/** A signal plus the reason it aborted. */
export type Watch = {
  /** Aborts on the caller's signal or on the deadline. */
  readonly signal: AbortSignal;
  /** Stops the timer and drops the caller's listener. */
  finish(): void;
  /**
   * Why {@link signal} aborted.
   *
   * `undefined` until it aborts.
   */
  reason(): DriverFailureKind | undefined;
};

/**
 * Reports whether `options` carries a signal or a timeout.
 *
 * @param options - Per-call options
 * @returns True when a {@link Watch} is required
 */
export function needsWatch(options: ExecuteOptions | undefined): boolean {
  return options?.signal !== undefined || options?.timeout !== undefined;
}

/**
 * Next transaction depth after one statement.
 *
 * Only a whole command matches, so `ROLLBACK TO SAVEPOINT` stays inside the
 * transaction. Kept here so a read does not load the batch runner.
 *
 * @param depth - Depth before the statement
 * @param text - Statement text
 * @returns Depth after a successful statement
 */
export function nextTransactionDepth(depth: number, text: string): number {
  const command = text.trim().replace(/;\s*$/, "").trim().toLowerCase();
  if (command === "begin" || command === "begin work" || command === "begin transaction") {
    return depth + 1;
  }
  if (command === "commit" || command === "commit work" || command === "end") {
    return Math.max(0, depth - 1);
  }
  if (command === "rollback" || command === "rollback work") return 0;
  return depth;
}

/**
 * Opens a watch for one call.
 *
 * The caller has already rejected a pre-aborted signal and a non-positive
 * timeout.
 *
 * @param options - Options that include a signal or a timeout
 * @returns The watch. The caller must {@link Watch.finish} it
 */
export function openWatch(options: ExecuteOptions): Watch {
  let kind: DriverFailureKind | undefined;
  const controller = new AbortController();
  const onAbort = (): void => {
    if (kind === undefined) kind = "cancelled";
    controller.abort();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeout !== undefined) {
    timer = setTimeout(() => {
      if (kind === undefined) kind = "timeout";
      controller.abort();
    }, options.timeout);
  }
  return {
    signal: controller.signal,
    finish() {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    },
    reason() {
      return kind;
    },
  };
}

/**
 * Runs `fn` with a watch when the caller set a signal or a timeout.
 *
 * A plain call passes `undefined` and returns `fn`'s promise unchanged.
 *
 * @param closed - The pool has been closed
 * @param options - Per-call options
 * @param fn - Work that receives the watch
 * @returns Whatever `fn` returns
 */
export function runCall<T>(
  closed: boolean,
  options: ExecuteOptions | undefined,
  fn: (watch: Watch | undefined) => Promise<T>,
): Promise<T> {
  if (closed) return rejectClosed();
  if (options?.signal?.aborted === true) return rejectCancelled();
  if (options?.timeout !== undefined && options.timeout <= 0) return rejectTimedOut();
  if (options === undefined || !needsWatch(options)) return fn(undefined);
  const watch = openWatch(options);
  return fn(watch).finally(() => {
    watch.finish();
  });
}
