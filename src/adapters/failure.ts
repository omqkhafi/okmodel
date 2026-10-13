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
 * The SQLSTATE is `08006` so the failure is classified as a lost connection
 * from structured data. The message is not read.
 *
 * @param message - Error text. Defaults to that SQLSTATE
 * @returns A rejected promise
 */
export function rejectClosed(message = "08006"): Promise<never> {
  return driverErrors().then((mod) =>
    Promise.reject(new mod.DriverError(message, { sqlstate: message })),
  );
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
