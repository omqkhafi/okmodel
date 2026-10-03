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
import { driverErrors, mapFailure, rejectClosed } from "../failure.js";
import { runCall, type Watch } from "./call.js";
import { cursorStream, noticeBuffer, WireSession, type WireQuery } from "./session.js";

export {
  BUNSQL_CAPABILITIES as capabilities,
  hasCapability,
  readCapability,
} from "../capabilities.js";
export { DriverError } from "../error.js";

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

/** Pool occupancy. */
type Counters = {
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

  return {
    capabilities: BUNSQL_CAPABILITIES,
    execute(text, params, options) {
      return runCall(closed, options, async (watch) => {
        await releaseParked(parked);
        return root.query(text, params, watch);
      });
    },
    async batch(statements, options) {
      const connection = await checkout();
      try {
        return await connection.batch(statements, options);
      } finally {
        await connection.release();
      }
    },
    reserve: () => checkout(),
    stream(text, params) {
      return stream(text, params);
    },
    listen(channel, onNotify) {
      return listen(channel, onNotify);
    },
    stats: () => statsOf(counters, max),
    async close() {
      closed = true;
      await releaseParked(parked);
      await sql.close();
    },
  };

  async function checkout(): Promise<DriverConnection> {
    if (closed) return rejectClosed();
    const reserved = parked.pop() ?? (await reserve(sql, acquireMs, counters));
    counters.reserved += 1;
    const session = new WireSession(
      (text, params) => send(reserved, text, params),
      notices,
      isClosed,
      false,
      () => {
        counters.reservedBusy += 1;
      },
      () => {
        counters.reservedBusy = Math.max(0, counters.reservedBusy - 1);
      },
    );
    let released = false;
    return {
      execute: (text, params, options) =>
        runCall(closed, options, (watch) => session.query(text, params, watch)),
      batch: (statements, options) =>
        runCall(closed, options, async (watch: Watch | undefined) => {
          const { runAtomicBatch } = await import("./batch.js");
          return runAtomicBatch(session, statements, watch);
        }),
      async release() {
        if (released) return;
        released = true;
        try {
          await reset(session, reserved);
        } finally {
          counters.reserved = Math.max(0, counters.reserved - 1);
          await park(parked, reserved);
        }
      },
    };
  }

  function stream(
    text: string,
    params?: readonly WireValue[],
  ): AsyncIterable<readonly (readonly WireValue[])[]> {
    return (async function* () {
      const connection = await checkout();
      try {
        yield* cursorStream(
          (statement, values) => connection.execute(statement, values),
          text,
          params,
        );
      } finally {
        await connection.release();
      }
    })();
  }

  async function listen(
    channel: string,
    onNotify: (payload: string) => void,
  ): Promise<() => Promise<void>> {
    if (closed) return rejectClosed();
    await releaseParked(parked);
    const subscription = await sql.listen(channel, onNotify);
    return async () => {
      await subscription.unlisten();
    };
  }
}

function send(sql: SQL, text: string, params: readonly WireValue[] | undefined): WireQuery {
  if (params === undefined || params.length === 0) return sql.unsafe(text).raw();
  return sql.unsafe(text, [...params]).raw();
}

async function reserve(
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

async function park(parked: ReservedSQL[], reserved: ReservedSQL): Promise<void> {
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

async function reset(session: WireSession, sql: SQL): Promise<void> {
  const run = (text: string): Promise<unknown> => sql.unsafe(text);
  if (session.depth() > 0) await run("ROLLBACK").catch(() => undefined);
  try {
    await run("RESET ALL");
    await run("SELECT pg_advisory_unlock_all()");
  } catch {
    await run("ROLLBACK").catch(() => undefined);
    await run("RESET ALL");
    await run("SELECT pg_advisory_unlock_all()");
  }
}

function statsOf(counters: Counters, size: number): DriverStats {
  return {
    size,
    idle: Math.max(0, size - counters.reserved - counters.busy),
    inflight: counters.busy + counters.reservedBusy,
    waiting: counters.waiting,
  };
}
