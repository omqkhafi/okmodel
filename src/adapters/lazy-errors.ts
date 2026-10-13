/**
 * Error text a connect entry does not need until a call fails.
 *
 * Loaded on the first closed pool or on a positive `timeout` for a driver
 * that cannot cancel. A successful execute does not import this module.
 */

import { OkmError } from "../contracts/error.js";
import { DriverError } from "./error.js";

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
