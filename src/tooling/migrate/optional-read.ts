/**
 * Optional reads of the target (D194, D329).
 *
 * `okm generate` and `okm migrate plan` read a target only to seal catalogs
 * and to print row estimates. Neither read decides the plan's steps, so a
 * target that does not answer must not hold the command. Every such read uses
 * one short connect timeout, and one note says what was left out.
 */

import { isConnectionFailure } from "../../contracts/connection.js";
import { missingPostgres } from "../cli/outcome.js";

/** Seconds an optional read waits for a connection before it is skipped. */
export const OPTIONAL_CONNECT_SECONDS = 3;

/** The line written to stderr when an optional read was skipped. */
export const SKIPPED_READ_NOTE =
  "note: target unreachable, so this plan has no row estimates and no live comparison";

/**
 * Whether a failed optional read means "skip it".
 *
 * A connection failure, a connect timeout, and a missing `postgres` package
 * qualify. A server error such as a bad password does not.
 *
 * @param error - Caught value
 * @returns `true` when the read may be left out
 */
export function skippableRead(error: unknown): boolean {
  return isConnectionFailure(error) || missingPostgres(error) !== undefined;
}
