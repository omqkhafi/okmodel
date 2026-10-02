/**
 * Connection failures shared by adapters and the Postgres error mapping.
 *
 * A lost connection during `COMMIT` is `outcome_unknown` (the adapter decides
 * that). Any other connection failure is kind `unavailable`.
 */

/**
 * Reports whether `sqlstate` is a connection or availability class.
 *
 * Class `08` is connection exception. `53300` is too many connections.
 * `57P01`–`57P03` are shutdown and "cannot connect now".
 *
 * @param sqlstate - Postgres SQLSTATE
 * @returns `true` when the server could not keep the session
 */
export function isConnectionSqlstate(sqlstate: string): boolean {
  return (
    sqlstate.startsWith("08") ||
    sqlstate === "53300" ||
    sqlstate === "57P01" ||
    sqlstate === "57P02" ||
    sqlstate === "57P03"
  );
}

/**
 * Reports whether a driver or OS code means the socket is gone.
 *
 * @param code - `error.code` from Node or the driver
 * @returns `true` for a refused, reset, or closed connection
 */
export function isConnectionErrno(code: string): boolean {
  switch (code) {
    case "ECONNRESET":
    case "ECONNREFUSED":
    case "EPIPE":
    case "ENOTFOUND":
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EAI_AGAIN":
    case "CONNECTION_CLOSED":
    case "CONNECTION_ENDED":
    case "CONNECTION_DESTROYED":
      return true;
    default:
      return false;
  }
}

/**
 * Reports whether `error` is a dropped or refused connection.
 *
 * Constraint failures are not connection failures. `23505` stays a unique
 * violation even when it is raised at commit.
 *
 * @param error - Caught value
 * @returns `true` when no session remains
 */
export function isConnectionFailure(error: unknown): boolean {
  const sqlstate = readCode(error, "sqlstate") ?? readCode(error, "code");
  if (sqlstate !== undefined && (isConnectionSqlstate(sqlstate) || isConnectionErrno(sqlstate))) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  const message = error.message;
  return (
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("CONNECTION_CLOSED") ||
    message.includes("terminating connection") ||
    message.includes("The pool is closed")
  );
}

function readCode(error: unknown, key: string): string | undefined {
  if (typeof error !== "object" || error === null || !(key in error)) return undefined;
  const value: unknown = Reflect.get(error, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
