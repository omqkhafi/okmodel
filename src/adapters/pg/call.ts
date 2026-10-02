/**
 * One deadline for a call.
 *
 * Created only when the caller passed `signal` or `timeout`. A plain execute
 * does not allocate one.
 */

import type { DriverFailureKind, ExecuteOptions } from "../../contracts/driver.js";
import { cancelled, DriverError, timedOut } from "../error.js";

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
  if (closed) return Promise.reject(new DriverError("The pool is closed."));
  if (options?.signal?.aborted === true) return Promise.reject(cancelled());
  if (options?.timeout !== undefined && options.timeout <= 0) return Promise.reject(timedOut());
  if (options === undefined || !needsWatch(options)) return fn(undefined);
  const watch = openWatch(options);
  return fn(watch).finally(() => {
    watch.finish();
  });
}
