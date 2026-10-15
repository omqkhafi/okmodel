/**
 * Bun.sql adapter (`okmodel/pg/bun`).
 *
 * Bun's built-in client. There is no package to install. This module is the
 * only place that imports `bun`. It runs on Bun; another runtime cannot load
 * that import.
 *
 * `idleTimeout` stays 0, which is Bun's default: no idle timer, and a
 * finished script exits without `close()`. `Query.cancel()` does not abort
 * the backend, so `cancel` is false. Server notices are not surfaced.
 */

import { SQL, type ReservedSQL } from "bun";

import type {
  DriverConnection,
  DriverPool,
  DriverPoolConfig,
  DriverStats,
  WireValue,
} from "../../contracts/driver.js";
import { BUNSQL_CAPABILITIES } from "../capabilities.js";
import { DriverError } from "../error.js";
import { driverErrors, mapFailure, rejectClosed } from "../failure.js";
import { runCall } from "./call.js";
import { noTimeout } from "./no-inflight-timeout.js";
import { noticeBuffer, WireSession, type WireQuery } from "./session.js";

export {
  BUNSQL_CAPABILITIES as capabilities,
  hasCapability,
  readCapability,
} from "../capabilities.js";
export { DriverError };

/** TLS values Bun.sql accepts that this adapter forwards. */
export type BunSqlTls =
  | boolean
  | "disable"
  | "allow"
  | "prefer"
  | "require"
  | "verify-ca"
  | "verify-full";

/** Options for {@link open}. */
export type BunSqlConfig = DriverPoolConfig & {
  /** Connection URL for this endpoint. */
  readonly url: string;
  /**
   * Named prepared statements, or the unnamed protocol.
   *
   * Unnamed is the default (`prepare: false`). `prepared: "named"` is not
   * for transaction-mode poolers.
   */
  readonly prepared?: "named" | "unnamed";
  /** Session search path for every connection in the pool. */
  readonly searchPath?: string;
  /** TLS mode passed to Bun.sql. */
  readonly ssl?: BunSqlTls;
};

/** What a checkout needs from the pool that opened it. */
export type HeldPool = {
  readonly sql: SQL;
  readonly parked: ReservedSQL[];
  readonly acquireMs: number | undefined;
  readonly counters: Counters;
  readonly notices: ReturnType<typeof noticeBuffer>;
  readonly isClosed: () => boolean;
};

/** Pool occupancy. */
export type Counters = {
  reserved: number;
  busy: number;
  reservedBusy: number;
  waiting: number;
};

/**
 * Opens a Bun.sql pool for one endpoint.
 *
 * @param config - URL, pool size, and acquire timeout
 * @returns The pool
 */
export function open(config: BunSqlConfig): DriverPool {
  const max = config.max ?? 10;
  const acquireMs = config.timeouts?.acquire;
  const counters: Counters = { reserved: 0, busy: 0, reservedBusy: 0, waiting: 0 };
  const notices = noticeBuffer();
  let closed = false;
  const isClosed = (): boolean => closed;
  const named = config.prepared === "named";
  // Bun.sql hands the next reserve to a fresh connection until `max` is
  // full. Parking the last release makes the next checkout the same session,
  // which is what the reset check observes. Queries and listen give it back
  // so the slot is not stuck.
  const parked: ReservedSQL[] = [];

  const sql = new SQL(config.url, {
    max,
    idleTimeout: 0,
    maxLifetime: 0,
    prepare: named,
    bigint: false,
    connectionTimeout: 5,
    connection: {
      application_name: "okmodel",
      ...(config.searchPath !== undefined ? { search_path: config.searchPath } : {}),
    },
    ...(config.ssl !== undefined ? { tls: config.ssl } : {}),
  });

  const root = new WireSession(
    (text, params) => send(sql, text, params),
    notices,
    isClosed,
    false,
    () => {
      counters.busy += 1;
    },
    () => {
      counters.busy = Math.max(0, counters.busy - 1);
    },
  );

  const held: HeldPool = { sql, parked, acquireMs, counters, notices, isClosed };
  const checkout = (): Promise<DriverConnection> =>
    closed ? rejectClosed() : import("./bunsql-extra.js").then((mod) => mod.checkout(held));

  return {
    capabilities: BUNSQL_CAPABILITIES,
    execute(text, params, options) {
      const refused = noTimeout(options);
      if (refused !== undefined) return refused;
      return runCall(closed, options, (watch) =>
        releaseParked(parked).then(() =>
          root
            .query(text, params, watch)
            .catch((error: unknown) =>
              import("./bunsql-extra.js").then((mod) =>
                mod.reopen(error, () => root.query(text, params, watch)),
              ),
            ),
        ),
      );
    },
    async batch(statements, options) {
      const refused = noTimeout(options);
      if (refused !== undefined) return refused;
      const connection = await checkout();
      try {
        return await connection.batch(statements, options);
      } finally {
        await connection.release();
      }
    },
    reserve: () => checkout(),
    stream(text, params) {
      return (async function* () {
        const { streamRows } = await import("./bunsql-extra.js");
        yield* streamRows(checkout, text, params);
      })();
    },
    listen(channel, onNotify) {
      return import("./bunsql-extra.js").then((mod) =>
        mod.listen(sql, parked, closed, channel, onNotify),
      );
    },
    stats: () => statsOf(counters, max),
    async close() {
      closed = true;
      await releaseParked(parked);
      await sql.close();
    },
  };
}

export function send(sql: SQL, text: string, params: readonly WireValue[] | undefined): WireQuery {
  const refused = refuseInt8(params);
  if (refused !== undefined) return refused;
  if (params === undefined || params.length === 0) return sql.unsafe(text).raw();
  return sql.unsafe(text, [...params]).raw();
}

/**
 * Rejects a canonical integer outside the signed int8 range.
 *
 * The other drivers get SQLSTATE 22003 from the server. Bun.sql does not, so
 * the refusal is a rejected query the session maps like that SQLSTATE.
 *
 * @param params - Wire parameters
 * @returns A rejected query, or `undefined` when every integer fits
 */
function refuseInt8(params: readonly WireValue[] | undefined): WireQuery | undefined {
  if (params === undefined) return undefined;
  for (const value of params) {
    if (value === null || value.length < 19 || !/^-?(?:0|[1-9]\d*)$/.test(value)) continue;
    const parsed = BigInt(value);
    if (parsed > 9223372036854775807n || parsed < -9223372036854775808n) {
      return Promise.reject(
        new DriverError("bigint out of range", { sqlstate: "22003" }),
      ) as WireQuery;
    }
  }
  return undefined;
}

export async function reserve(
  sql: SQL,
  acquireMs: number | undefined,
  counters: Counters,
): Promise<ReservedSQL> {
  counters.waiting += 1;
  try {
    if (acquireMs === undefined) return await sql.reserve();
    return await sql.reserve({ signal: AbortSignal.timeout(acquireMs) });
  } catch (error) {
    if (isAbort(error)) {
      const errors = await driverErrors();
      throw errors.acquireTimeout();
    }
    throw await mapFailure(error);
  } finally {
    counters.waiting = Math.max(0, counters.waiting - 1);
  }
}

export async function park(parked: ReservedSQL[], reserved: ReservedSQL): Promise<void> {
  parked.push(reserved);
  while (parked.length > 1) {
    const extra = parked.shift();
    if (extra !== undefined) await releaseReserved(extra);
  }
}

async function releaseParked(parked: ReservedSQL[]): Promise<void> {
  const pending = parked.splice(0);
  for (const reserved of pending) await releaseReserved(reserved);
}

function releaseReserved(reserved: ReservedSQL): Promise<void> {
  const done: unknown = reserved.release();
  return done instanceof Promise ? done.then(() => undefined) : Promise.resolve();
}

function isAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

function statsOf(counters: Counters, size: number): DriverStats {
  return {
    size,
    idle: Math.max(0, size - counters.reserved - counters.busy),
    inflight: counters.busy + counters.reservedBusy,
    waiting: counters.waiting,
  };
}
