/**
 * Driver-error constructors, loaded on the first failure.
 *
 * A successful `execute` does not import {@link import("./error.js")}.
 */

type ErrorModule = typeof import("./error.js");

let loading: Promise<ErrorModule> | undefined;

/**
 * Loads driver-error constructors once.
 *
 * @returns The error module
 */
export function driverErrors(): Promise<ErrorModule> {
  loading ??= import("./error.js");
  return loading;
}

/**
 * Rejects with a closed-pool {@link import("./error.js").DriverError}.
 *
 * The text and SQLSTATE `08006` load with the lazy error module. Classification
 * reads the SQLSTATE. The message is "The pool is closed."
 *
 * @returns A rejected promise
 */
export function rejectClosed(): Promise<never> {
  return import("./lazy-errors.js").then((mod) => mod.closed());
}

/**
 * Rejects with OKM1120 when a driver cannot cancel a positive timeout.
 *
 * The message stays `timeout`. Kind stays `invalid`. Bun.sql, PGlite, and Neon call
 * this. Other drivers do not, so their connect graphs omit it.
 *
 * @returns A rejected promise
 */
export function rejectUncancellable(): Promise<never> {
  return import("./lazy-errors.js").then((mod) => mod.refused());
}

/**
 * Rejects with kind `cancelled`.
 *
 * @returns A rejected promise
 */
export function rejectCancelled(): Promise<never> {
  return driverErrors().then((mod) => Promise.reject(mod.cancelled()));
}

/**
 * Rejects with kind `timeout`.
 *
 * @returns A rejected promise
 */
export function rejectTimedOut(): Promise<never> {
  return driverErrors().then((mod) => Promise.reject(mod.timedOut()));
}

/**
 * Maps a caught driver exception.
 *
 * @param error - Caught value
 * @returns A normalised error
 */
export async function mapFailure(error: unknown): Promise<unknown> {
  const mod = await driverErrors();
  return mod.mapDriverError(error);
}
