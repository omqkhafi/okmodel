/**
 * Connection failures the shared code list does not name.
 *
 * {@link import("../../contracts/connection.js").isConnectionFailure} stays
 * message-blind and does not grow. Bun's read retry uses that function, so a
 * refused Bun.sql socket is not retried here. This module only decides the
 * kind. It loads with the Postgres error mapper.
 */

import { isConnectionSqlstate } from "../../contracts/connection.js";

/** What a walk found on one error chain. */
type Hit = {
  readonly dropped: boolean;
  readonly code: string | undefined;
  readonly message: string | undefined;
};

const NONE: Hit = { dropped: false, code: undefined, message: undefined };

/**
 * Reports whether `error` is a refused, reset, or dropped connection that
 * {@link import("../../contracts/connection.js").isConnectionFailure} misses.
 *
 * A SQLSTATE that is not a connection class wins, including one on `errno`.
 * Codes count on the error, its `cause`, a Neon HTTP `sourceError`, and an
 * `ErrorEvent`'s `error`. node-postgres has no code on two messages; only
 * those two match.
 *
 * @param error - A driver error, usually a `DriverError`
 * @returns `true` when the kind is `unavailable`
 */
export function isDroppedConnection(error: unknown): boolean {
  return walk(error, 0, new Set())?.dropped === true;
}

/**
 * Driver code and message safe to keep on an {@link import("../../contracts/error.js").OkmError} cause.
 *
 * Empty when this chain is not a dropped connection. A SQLSTATE veto returns
 * nothing, so a unique violation does not gain a connection message.
 *
 * @param error - The driver error's cause
 * @returns The code and the fixed driver text, when this chain has them
 */
export function connectionCause(error: unknown): {
  readonly code?: string;
  readonly message?: string;
} {
  const hit = walk(error, 0, new Set());
  if (hit === undefined || !hit.dropped) return {};
  return {
    ...(hit.code !== undefined ? { code: hit.code } : {}),
    ...(hit.message !== undefined ? { message: hit.message } : {}),
  };
}

function walk(error: unknown, depth: number, seen: Set<object>): Hit | undefined {
  if (typeof error !== "object" || error === null || depth > 8) return undefined;
  if (seen.has(error)) return undefined;
  seen.add(error);
  const state = sqlstate(error);
  if (state !== undefined) {
    return isConnectionSqlstate(state) && state !== "53300" ? { ...NONE, dropped: true } : NONE;
  }
  const code = text(error, "code") ?? text(error, "errno");
  if (code !== undefined && isConnectCode(code)) {
    return { dropped: true, code, message: fixedMessage(error) };
  }
  const message = fixedMessage(error);
  if (message !== undefined) return { dropped: true, code: undefined, message };
  for (const key of ["error", "sourceError", "cause"] as const) {
    const next: unknown = Reflect.get(error, key);
    if (next === undefined || next === error) continue;
    const found = walk(next, depth + 1, seen);
    if (found !== undefined) return found;
  }
  if (isErrorEvent(error)) {
    return { dropped: true, code: undefined, message: websocketMessage(error) };
  }
  return undefined;
}

function isErrorEvent(error: object): boolean {
  const ctor: unknown = Reflect.get(error, "constructor");
  return typeof ctor === "function" && ctor.name === "ErrorEvent";
}

/**
 * A five-character SQLSTATE on `sqlstate`, `code`, or `errno`.
 *
 * @param error - One node of the chain
 * @returns The SQLSTATE, or `undefined`
 */
function sqlstate(error: object): string | undefined {
  for (const key of ["sqlstate", "code", "errno"] as const) {
    const value = text(error, key);
    if (value !== undefined && /^[0-9A-Z]{5}$/.test(value)) return value;
  }
  return undefined;
}

function text(error: object, key: string): string | undefined {
  if (!(key in error)) return undefined;
  const value: unknown = Reflect.get(error, key);
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : undefined;
}

/**
 * Codes that mean the socket never became a session.
 *
 * `ConnectionRefused` is Bun's fetch code. The others are Node and Bun.sql.
 *
 * @param code - `error.code` or `error.errno`
 * @returns `true` for a refused, reset, or unresolvable connect
 */
function isConnectCode(code: string): boolean {
  switch (code) {
    case "ECONNRESET":
    case "ECONNREFUSED":
    case "EPIPE":
    case "ETIMEDOUT":
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "ERR_POSTGRES_CONNECTION_REFUSED":
    case "ERR_POSTGRES_CONNECTION_CLOSED":
    case "ConnectionRefused":
      return true;
    default:
      return false;
  }
}

/**
 * The two node-postgres texts that carry no code.
 *
 * @param error - One node of the chain
 * @returns That text, or `undefined`
 */
/** node-postgres pool checkout deadline. Not a dropped socket. */
const POOL_ACQUIRE = "timeout exceeded when trying to connect";

function fixedMessage(error: object): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (
    error.message === "Connection terminated unexpectedly" ||
    error.message === "Connection terminated due to connection timeout"
  ) {
    return error.message;
  }
  return undefined;
}

/**
 * Reports whether `error` is the node-postgres pool checkout deadline.
 *
 * The text is `timeout exceeded when trying to connect`. That wait is
 * OKM1846. A TCP connect that dies is `Connection terminated due to connection
 * timeout` and stays {@link isDroppedConnection}.
 *
 * @param error - A driver error, usually a `DriverError`
 * @returns `true` when the kind is the acquire timeout
 */
export function isPoolAcquireTimeout(error: unknown): boolean {
  return sawPoolAcquire(error, 0, new Set());
}

function sawPoolAcquire(error: unknown, depth: number, seen: Set<object>): boolean {
  if (typeof error !== "object" || error === null || depth > 8) return false;
  if (seen.has(error)) return false;
  seen.add(error);
  if (error instanceof Error && error.message === POOL_ACQUIRE) return true;
  for (const key of ["error", "sourceError", "cause"] as const) {
    const next: unknown = Reflect.get(error, key);
    if (next === undefined || next === error) continue;
    if (sawPoolAcquire(next, depth + 1, seen)) return true;
  }
  return false;
}

/**
 * Neon WebSocket's connect failure, which Bun reports with no code.
 *
 * The text names the socket, not a row. A password in the text is left off
 * the cause.
 *
 * @param error - An `ErrorEvent`, when this node is one
 * @returns The socket text, or `undefined`
 */
function websocketMessage(error: object): string | undefined {
  if (!isErrorEvent(error)) return undefined;
  const inner: unknown = Reflect.get(error, "error");
  if (!(inner instanceof Error)) return undefined;
  const message = inner.message;
  if (message.length === 0 || message.length > 200 || message.includes("@")) return undefined;
  if (!message.startsWith("WebSocket connection to ")) return undefined;
  return message;
}
