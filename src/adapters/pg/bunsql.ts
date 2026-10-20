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

import { SQL as BunSQL } from "bun";

import type { ReservedSQL, SQL } from "./bun-sql.js";

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
import { runCall, type Watch } from "./call.js";
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
  readonly acquireMs: number | undefined;
  readonly counters: Counters;
  readonly notices: ReturnType<typeof noticeBuffer>;
  readonly isClosed: () => boolean;
  /** Sockets this pool has closed. The count never returns to zero. */
  readonly closures: () => number;
  /**
   * Drops a pool Bun has wedged.
   *
   * `connection must be a PostgresSQLConnection` does not recover on the same
   * client, and `close()` on that client does not return. The next call uses
   * the replacement. A checkout still holding the dead client, or a `dead`
   * client that was already replaced, leaves the current client in place.
   *
   * @param dead - The client that rejected the statement
   * @returns The client the next statement should use, or `undefined` when the pool is closed
   */
  readonly replaceDead: (dead: SQL) => SQL | undefined;
};

/**
 * Bun.sql's wrapper is gone.
 *
 * The text carries no SQLSTATE. A closed socket (`Connection closed`) is not
 * this: that one still dials on the same client.
 *
 * @param error - A rejection from `Bun.SQL`
 * @returns `true` when the client cannot serve another statement
 */
export function bunWrapperDead(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "connection must be a PostgresSQLConnection") return true;
  return (
    error.cause instanceof Error &&
    error.cause.message === "connection must be a PostgresSQLConnection"
  );
}

const clientPools = new WeakSet<DriverPool>();

/**
 * Marks a pool opened for a client.
 *
 * A client read that finds a dead socket is tried once. A pool from raw
 * {@link open} is not marked, so a statement the server killed while it was
 * running is not started again.
 *
 * @param pool - The pool `connect` just opened
 */
export function markClientPool(pool: DriverPool): void {
  clientPools.add(pool);
}

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
  // A backend the server has already closed. The next statement drains it
  // before reuse. The count lives on this pool, not at module scope.
  // `dropped` is cleared after a drain. `closures` only grows, so a reserved
  // handle can see a reconnect that the drain already forgot.
  let dropped = 0;
  let closures = 0;

  const make = (): SQL =>
    new BunSQL(config.url, {
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
      onclose() {
        dropped += 1;
        closures += 1;
      },
    });
  const slot = { sql: make() };
  const replaceDead = (dead: SQL): SQL | undefined => {
    if (closed) return undefined;
    if (slot.sql !== dead || counters.reserved !== 0) return slot.sql;
    // The wedged client is not closed: close() does not return (oven-sh/bun#46166).
    slot.sql = make();
    dropped = 0;
    closures += 1;
    return slot.sql;
  };

  const root = new WireSession(
    (text, params) => send(slot.sql, text, params),
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

  const held: HeldPool = {
    get sql() {
      return slot.sql;
    },
    acquireMs,
    counters,
    notices,
    isClosed,
    closures: () => closures,
    replaceDead,
  };

  const run = (
    text: string,
    params: readonly WireValue[] | undefined,
    watch: Watch | undefined,
  ): ReturnType<WireSession["query"]> => {
    const sent = dropped;
    return root
      .query(text, params, watch)
      .catch((error: unknown) =>
        import("./bunsql-extra.js").then((mod) =>
          mod.recover(
            slot.sql,
            error,
            text,
            root.depth(),
            clientPools.has(pool),
            dropped > sent,
            () => root.query(text, params, watch),
            replaceDead,
          ),
        ),
      );
  };

  const afterDrop = (
    text: string,
    params: readonly WireValue[] | undefined,
    watch: Watch | undefined,
  ): ReturnType<WireSession["query"]> => {
    if (dropped === 0) return run(text, params, watch);
    const seen = dropped;
    return import("./bunsql-extra.js").then((mod) =>
      mod.drainClosed(slot.sql, replaceDead).then(() => {
        if (dropped === seen) dropped = 0;
        return run(text, params, watch);
      }),
    );
  };
  const checkout = (): Promise<DriverConnection> =>
    closed ? rejectClosed() : import("./bunsql-extra.js").then((mod) => mod.checkout(held));

  const pool: DriverPool = {
    capabilities: BUNSQL_CAPABILITIES,
    execute(text, params, options) {
      const refused = noTimeout(options);
      if (refused !== undefined) return refused;
      return runCall(closed, options, (watch) => afterDrop(text, params, watch));
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
        mod.listen(slot.sql, closed, channel, onNotify),
      );
    },
    stats: () => statsOf(counters, max),
    async close() {
      closed = true;
      await slot.sql.close();
    },
  };
  return pool;
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
  replaceDead?: (dead: SQL) => SQL | undefined,
): Promise<ReservedSQL> {
  counters.waiting += 1;
  try {
    try {
      return await take(sql, acquireMs);
    } catch (error) {
      const next = bunWrapperDead(error) ? replaceDead?.(sql) : undefined;
      if (next === undefined || next === sql) throw error;
      return await take(next, acquireMs);
    }
  } catch (error) {
    if (isAbort(error)) {
      const errors = await driverErrors();
      throw errors.acquireTimeout();
    }
    // Bun.sql closed-socket texts carry no code. Stamp 08006 here so a
    // reserve that fails before the reserved-handle guard still classifies
    // as unavailable (B-03). Kept off the shared mapDriverError path so the
    // postgres.js incremental gate does not grow.
    if (
      error instanceof Error &&
      (error.message === "Connection closed" ||
        error.message === "connection must be a PostgresSQLConnection")
    ) {
      throw new DriverError(error.message, { cause: error, sqlstate: "08006" });
    }
    throw await mapFailure(error);
  } finally {
    counters.waiting = Math.max(0, counters.waiting - 1);
  }
}

function take(sql: SQL, acquireMs: number | undefined): Promise<ReservedSQL> {
  if (acquireMs === undefined) return sql.reserve();
  return sql.reserve({ signal: AbortSignal.timeout(acquireMs) });
}

/**
 * Returns a reserved handle to Bun's pool.
 *
 * @param reserved - The handle to release
 */
export function releaseReserved(reserved: ReservedSQL): Promise<void> {
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
