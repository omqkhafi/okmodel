/**
 * Error text and driver-error mapping a connect entry does not need until a call fails.
 *
 * Loaded on the first closed pool, the first mapped driver failure, or on a
 * positive `timeout` for a driver that cannot cancel. A successful execute
 * does not import this module, so {@link readCode} stays off the cold graph.
 */

import { isSqlstate, readCode as errorField } from "../contracts/connection.js";
import { OkmError } from "../contracts/error.js";
import {
  acquireTimeout,
  cancelled,
  DriverError,
  driverFields,
  outcomeUnknown,
  timedOut,
} from "./error.js";

export { acquireTimeout, cancelled, DriverError, outcomeUnknown, timedOut };

/**
 * Reads a string field from an unknown error object.
 *
 * Empty strings are absent. Shared with the connection check ({@link readCode}).
 * Loaded with the failure mapper, so a cold import does not carry it.
 *
 * @param error - Caught value
 * @param key - Field name
 * @returns The string, or `undefined`
 */
export { errorField };

/**
 * OKM1120 for a positive `timeout` on Bun.sql or PGlite.
 *
 * Kind stays `invalid`. The message stays `timeout` (D224, D239).
 *
 * @returns A rejected promise
 */
export function refused(): Promise<never> {
  return Promise.reject(new OkmError("OKM1120", "timeout"));
}

/**
 * A pool that has already been closed.
 *
 * The message is for people. Classification reads SQLSTATE `08006`.
 *
 * @returns A rejected promise
 */
export function closed(): Promise<never> {
  return Promise.reject(new DriverError("The pool is closed.", { sqlstate: "08006" }));
}

/**
 * SQLSTATE from a driver's own error object.
 *
 * postgres.js and node-postgres put it on `code`. Bun.sql puts
 * `ERR_POSTGRES_SERVER_ERROR` on `code` and the SQLSTATE on `errno`.
 *
 * @param error - Caught value
 * @returns A five-character SQLSTATE, or `undefined`
 */
function sqlstateOf(error: unknown): string | undefined {
  const code = errorField(error, "code");
  if (isSqlstate(code)) return code;
  const errno = errorField(error, "errno");
  if (isSqlstate(errno)) return errno;
  return errorField(error, "sqlstate");
}

/**
 * Maps a driver exception into {@link DriverError}.
 *
 * {@link OkmError} and {@link DriverError} pass through. A batch index on an
 * existing {@link DriverError} is applied with {@link DriverError.at}. Loaded
 * on the first failure. A cold import does not.
 *
 * @param error - Caught value
 * @param batchIndex - Statement index, or `null` at commit
 * @returns A normalised error
 */
export function mapDriverError(error: unknown, batchIndex?: number | null): unknown {
  if (error instanceof OkmError) return error;
  if (error instanceof DriverError) {
    return batchIndex === undefined ? error : error.at(batchIndex);
  }
  const message = messageOf(error);
  return new DriverError(
    message,
    driverFields({
      sqlstate: sqlstateOf(error),
      constraint: errorField(error, "constraint_name") ?? errorField(error, "constraint"),
      table: errorField(error, "table_name") ?? errorField(error, "table"),
      column: errorField(error, "column_name") ?? errorField(error, "column"),
      detail: errorField(error, "detail"),
      cause: error,
      batchIndex,
    }),
  );
}

/**
 * Text for a driver failure, never empty (QA-M1).
 *
 * A failed connect can throw an `AggregateError` with an empty message whose
 * first nested error has the text.
 *
 * @param error - Caught value
 * @returns A non-empty message
 */
function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return "driver error";
  if (error.message.length > 0) return error.message;
  const first = (error as { readonly errors?: readonly unknown[] }).errors?.[0];
  return first instanceof Error && first.message.length > 0 ? first.message : "driver error";
}
