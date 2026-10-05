/**
 * Pool operations a read does not use: checkout, describe, and stream.
 *
 * Loaded on the first reserve, batch, describe, or stream.
 */

import type { Sql } from "postgres";

import type {
  DescribeResult,
  DriverConnection,
  ExecuteResult,
  WireValue,
} from "../../contracts/driver.js";
import { isConnectionLost } from "../../contracts/connection.js";
import { driverErrors, mapFailure, rejectClosed } from "../failure.js";
import { runCall, type Watch } from "./call.js";
import { PgSession, type Canceller, type Counters, type NoticeBuffer } from "./postgresjs.js";
import { resultFrom, rowsFrom } from "./result.js";

const RESET_ALL = "RESET ALL";
const UNLOCK = "SELECT pg_advisory_unlock_all()";

/** State `open` shares with a checkout. */
export type HeldPool = {
  readonly sql: Sql;
  readonly acquireMs: number | undefined;
  readonly counters: Counters;
  readonly isClosed: () => boolean;
  readonly notices: NoticeBuffer;
  readonly named: boolean;
  readonly poolInflight: Set<Canceller>;
};

/**
 * Checks out one connection and clears it on release.
 *
 * @param pool - The open pool
 * @returns A connection the caller must release
 */
export async function checkout(pool: HeldPool): Promise<DriverConnection> {
  if (pool.isClosed()) return rejectClosed();
  const reserved = await reserveConnection(pool.sql, pool.acquireMs, pool.counters);
  pool.counters.reserved += 1;
  const local = new Set<Canceller>();
  const session = new PgSession(
    reserved,
    pool.counters,
    "reserved",
    local,
    pool.isClosed,
    pool.poolInflight,
    pool.notices,
    pool.named,
  );
  let released = false;
  // A reserved postgres.js connection that lost its socket crashes on the next write. Once a
  // statement fails because the connection is gone, nothing more is sent to it.
  let lost = false;
  const guard = <T>(run: () => Promise<T>): Promise<T> =>
    lost
      ? rejectClosed("The connection was lost.")
      : run().catch((error: unknown) => {
          if (isConnectionLost(error)) lost = true;
          throw error;
        });
  return {
    execute: (text, params, options) =>
      guard(() => runCall(pool.isClosed(), options, (watch) => session.query(text, params, watch))),
    batch: (statements, options) =>
      guard(() =>
        runCall(pool.isClosed(), options, async (watch: Watch | undefined) => {
          const { runAtomicBatch } = await import("./batch.js");
          return runAtomicBatch(session, statements, watch);
        }),
      ),
    cancel() {
      session.cancel();
    },
    async release() {
      if (released) return;
      released = true;
      try {
        if (!lost) await resetConnection(reserved, session.depth());
      } finally {
        pool.counters.reserved = Math.max(0, pool.counters.reserved - 1);
        // A closed connection is already back in the driver's closed list. Releasing it would put it
        // in the open list, and the next statement would write to a socket that is gone.
        if (!lost) reserved.release();
      }
    },
  };
}

/**
 * Describes a statement.
 *
 * @param sql - Pool client
 * @param text - SQL
 * @param params - Wire parameters
 * @returns Column names and the parameter count
 */
export async function describe(
  sql: Sql,
  text: string,
  params?: readonly WireValue[],
): Promise<DescribeResult> {
  const pending = sql.unsafe(text, asParams(params), { prepare: true });
  const described = await pending.describe();
  return {
    columns: described.columns.map((column) => column.name),
    parameterCount: described.types.length,
  };
}

/**
 * Yields cursor chunks.
 *
 * @param sql - Pool client
 * @param text - SQL
 * @param params - Wire parameters
 * @returns Chunks of wire rows
 */
export async function* stream(
  sql: Sql,
  text: string,
  params?: readonly WireValue[],
): AsyncIterable<readonly (readonly WireValue[])[]> {
  const pending = sql.unsafe(text, asParams(params));
  for await (const chunk of pending.cursor(64)) {
    yield rowsFrom(chunk);
  }
}

type ReservedConnection = Sql & {
  release(): void;
};

function reserveConnection(
  sql: Sql,
  acquireMs: number | undefined,
  counters: Counters,
): Promise<ReservedConnection> {
  counters.waiting += 1;
  let settled = false;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (acquireMs !== undefined) {
      timer = setTimeout(() => {
        settled = true;
        counters.waiting = Math.max(0, counters.waiting - 1);
        void driverErrors().then((errors) => {
          reject(errors.acquireTimeout());
        });
      }, acquireMs);
    }
    sql.reserve().then(
      (connection) => {
        if (settled) {
          void resetConnection(connection, 0).finally(() => {
            connection.release();
          });
          return;
        }
        if (timer !== undefined) clearTimeout(timer);
        counters.waiting = Math.max(0, counters.waiting - 1);
        resolve(connection);
      },
      (error: unknown) => {
        if (settled) return;
        if (timer !== undefined) clearTimeout(timer);
        counters.waiting = Math.max(0, counters.waiting - 1);
        void mapFailure(error).then(reject);
      },
    );
  });
}

async function resetConnection(sql: Sql, depth: number): Promise<void> {
  if (depth > 0) await sql.unsafe("ROLLBACK").catch(() => undefined);
  try {
    await sql.unsafe(RESET_ALL);
    await sql.unsafe(UNLOCK);
  } catch {
    await sql.unsafe("ROLLBACK").catch(() => undefined);
    await sql.unsafe(RESET_ALL);
    await sql.unsafe(UNLOCK);
  }
}

function asParams(params: readonly WireValue[] | undefined): string[] {
  if (params === undefined) return [];
  return params as unknown as string[];
}

/** Refcount a checkout or a listener borrows from the pool. */
type Gate = {
  enter(): void;
  leave(): void;
};

/**
 * Keeps sockets referenced until `release` finishes.
 *
 * The caller has already entered `gate`. A second `release` does not change
 * the count. Checkout failure leaves the gate.
 *
 * @param gate - Refcount already entered for this checkout
 * @param checkout - Reserves the connection
 * @returns The connection, with release counted once
 */
export async function holdCheckout<T extends { release(): Promise<void> }>(
  gate: Gate,
  checkout: () => Promise<T>,
): Promise<T> {
  try {
    const connection = await checkout();
    let released = false;
    const release = connection.release.bind(connection);
    connection.release = () => {
      if (released) return Promise.resolve();
      released = true;
      return release().finally(() => {
        gate.leave();
      });
    };
    return connection;
  } catch (error) {
    gate.leave();
    throw error;
  }
}

/**
 * Keeps sockets referenced for as long as the listener is active.
 *
 * The caller has already entered `gate`.
 *
 * @param gate - Listener refcount already entered
 * @param start - Subscribes and returns the stop function
 * @returns A stop function that can be called again
 */
export async function holdListener(
  gate: Gate,
  start: () => Promise<() => Promise<void>>,
): Promise<() => Promise<void>> {
  try {
    const stop = await start();
    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      try {
        await stop();
      } finally {
        gate.leave();
      }
    };
  } catch (error) {
    gate.leave();
    throw error;
  }
}

/**
 * Finishes a query that can be aborted by a signal or a timeout.
 *
 * The caller has already tracked `pending` and attached `onAbort`.
 *
 * @param pending - The in-flight statement
 * @param watch - Abort signal and the reason it fired
 * @param onAbort - Listener the caller attached
 * @param ctx - Notice slice and the session counters the plain path also uses
 * @returns The wire result, or a rejected driver error
 */
export function watchQuery(
  pending: Canceller & Promise<unknown>,
  watch: Watch,
  onAbort: () => void,
  ctx: {
    readonly start: number;
    readonly text: string;
    readonly notices: NoticeBuffer;
    leave(): void;
    note(text: string): void;
    untrack(pending: Canceller): void;
  },
): Promise<ExecuteResult> {
  return pending.then(
    (result) => {
      finishWatch(pending, watch, onAbort, ctx);
      const why = watch.reason();
      if (why === "timeout" || why === "cancelled") return classify(why, watch);
      ctx.note(ctx.text);
      return resultFrom(result, ctx.notices.since(ctx.start));
    },
    (error: unknown) => {
      finishWatch(pending, watch, onAbort, ctx);
      return classify(error, watch);
    },
  );
}

function finishWatch(
  pending: Canceller,
  watch: Watch,
  onAbort: () => void,
  ctx: { leave(): void; untrack(pending: Canceller): void },
): void {
  ctx.leave();
  ctx.untrack(pending);
  watch.signal.removeEventListener("abort", onAbort);
}

async function classify(error: unknown, watch: Watch): Promise<never> {
  const errors = await driverErrors();
  if (error instanceof errors.DriverError) return Promise.reject(error);
  const why = typeof error === "string" ? error : watch.reason();
  if (why === "timeout") {
    return Promise.reject(errors.timedOut(typeof error === "string" ? undefined : error));
  }
  const code = errors.errorField(error, "code");
  if (why === "cancelled" || code === "57014") {
    return Promise.reject(errors.cancelled(typeof error === "string" ? undefined : error));
  }
  return Promise.reject(errors.mapDriverError(error));
}
