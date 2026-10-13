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
    case "CONNECT_TIMEOUT":
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
 * The decision is a driver `code` ({@link isConnectionErrno}, including
 * `CONNECT_TIMEOUT`, or `ERR_POSTGRES_CONNECTION_CLOSED`) or a SQLSTATE in
 * class `08` or `57P01`–`57P03`. A server SQLSTATE outside that set is never
 * a lost connection. Message text is not read.
 *
 * @param error - Caught value
 * @returns `true` when no session remains
 */
export function isConnectionFailure(error: unknown): boolean {
  return at(error, true);
}

/**
 * Reports whether the connection is gone after `error`, or the outcome of a
 * statement on it is unknown (`outcome_unknown`).
 *
 * It reads what {@link isConnectionFailure} reads, and the error's `cause`.
 * Nothing more should be sent to such a connection: not a rollback, not a
 * reset. Loaded with the code that reserves a connection.
 *
 * @param error - Caught value
 * @returns `true` when the session cannot be used again
 */
export function isConnectionLost(error: unknown): boolean {
  return at(error, false);
}

function at(error: unknown, failure: boolean): boolean {
  if (typeof error !== "object" || error === null) return false;
  const named = readCode(error, "sqlstate");
  if (isState(named)) return lostState(named);
  const code = readCode(error, "code");
  const errno = readCode(error, "errno");
  if (
    code !== undefined &&
    (isConnectionErrno(code) || code === "ERR_POSTGRES_CONNECTION_CLOSED")
  ) {
    return true;
  }
  if (errno !== undefined && isConnectionErrno(errno)) return true;
  if (isState(code)) return lostState(code);
  if (isState(errno)) return lostState(errno);
  if (!failure && Reflect.get(error, "kind") === "outcome_unknown") return true;
  const cause: unknown = Reflect.get(error, "cause");
  return cause !== undefined && cause !== error && at(cause, failure);
}

function lostState(state: string): boolean {
  return isConnectionSqlstate(state) && state !== "53300";
}

function isState(value: string | undefined): value is string {
  return value !== undefined && /^[0-9A-Z]{5}$/.test(value);
}

function readCode(error: unknown, key: string): string | undefined {
  if (typeof error !== "object" || error === null || !(key in error)) return undefined;
  const value: unknown = Reflect.get(error, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
