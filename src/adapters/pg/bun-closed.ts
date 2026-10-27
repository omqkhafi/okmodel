/**
 * Bun.sql closed-socket text.
 *
 * Neither string carries a SQLSTATE. The session and the reserve path stamp
 * 08006 so the failure is `unavailable`. A successful statement does not use this.
 */

import { DriverError } from "../error.js";

/**
 * Reports whether `message` is a Bun.sql closed socket.
 *
 * @param message - Error text
 * @returns `true` for the two texts Bun.sql sends with no code
 */
export function isBunClosedMessage(message: string): boolean {
  return (
    message === "Connection closed" || message === "connection must be a PostgresSQLConnection"
  );
}

/**
 * A closed-socket error with SQLSTATE 08006.
 *
 * The text may be the error itself or its `cause`. Anything else is unchanged.
 *
 * @param error - A rejection from `Bun.SQL`
 * @returns A {@link DriverError}, or `error` when it is not that text
 */
export function closedSocketError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const message = isBunClosedMessage(error.message)
    ? error.message
    : error.cause instanceof Error && isBunClosedMessage(error.cause.message)
      ? error.cause.message
      : undefined;
  if (message === undefined) return error;
  if (error instanceof DriverError && error.sqlstate === "08006") return error;
  return new DriverError(message, { cause: error, sqlstate: "08006" });
}
