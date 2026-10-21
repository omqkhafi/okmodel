/**
 * Pool operations a read does not use: checkout, describe, and stream.
 *
 * Loaded on the first reserve, batch, describe, or stream.
 */

import type { Sql } from "postgres";

import type {
  DescribeResult,
  DriverConnection,
  ExecuteOptions,
  ExecuteResult,
  Statement,
  WireValue,
} from "../../contracts/driver.js";
import { isConnectionLost } from "../../contracts/connection.js";
import { DriverError, timedOut } from "../error.js";
import { driverErrors, mapFailure, rejectClosed } from "../failure.js";
import { runCall, type Watch } from "./call.js";
import { PgSession, type Canceller, type Counters, type NoticeBuffer } from "./postgresjs.js";
import { resultFrom, rowsFrom } from "./result.js";

const RESET_ALL = "RESET ALL";
const UNLOCK = "SELECT pg_advisory_unlock_all()";

/** Ignores a result. One function keeps the minified adapter under its gate. */
function discard(): void {}

type Lost = {
  on: boolean;
  /** Rejects the reset or drain that is using this reserved connection. */
  stop: () => void;
};

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
export async function checkout(pool: HeldPool, timeoutMs?: number): Promise<DriverConnection> {
  if (pool.isClosed()) return rejectClosed();
  const reserved = await reserveConnection(pool.sql, pool.acquireMs, pool.counters, timeoutMs);
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
  // postgres.js queues a small write with setImmediate. nextWrite then calls
  // socket.write. After closed() sets the socket to null, that timer throws
  // outside the query promise. The close handler sets `lost` before the next
  // statement, savepoint, or COMMIT, so that write is never scheduled.
  const lost = { on: false, stop: discard };
  arm(reserved, lost);
  let limit = timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : 0;
  const remember = (timeout: number | undefined): void => {
    if (timeout !== undefined && timeout > 0) limit = timeout;
  };
  const guard = <T>(run: () => Promise<T>): Promise<T> =>
    lost.on
      ? rejectClosed()
      : run().catch((error: unknown) => {
          if (isConnectionLost(error)) lost.on = true;
          throw error;
        });
  return {
    execute: (text, params, options) => {
      remember(options?.timeout);
      return guard(() =>
        runCall(pool.isClosed(), options, (watch) => session.query(text, params, watch)),
      );
    },
    batch: (statements, options) => {
      remember(options?.timeout);
      return guard(() =>
        runCall(pool.isClosed(), options, async (watch: Watch | undefined) => {
          const { runAtomicBatch } = await import("./batch.js");
          return runAtomicBatch(session, statements, watch);
        }),
      );
    },
    cancel() {
      session.cancel();
    },
    async release() {
      if (released) return;
      released = true;
      const ms = limit;
      try {
        if (!lost.on) await deadline(ms, () => resetConnection(reserved, session.depth()), lost);
      } catch {
        lost.on = true;
      } finally {
        pool.counters.reserved = Math.max(0, pool.counters.reserved - 1);
        // A closed connection is already back in the driver's closed list. Releasing it would put it
        // in the open list, and the next statement would write to a socket that is gone.
        // The fatal ErrorResponse can still be sitting on that connection and is delivered to the
        // next query. A discarded statement consumes it. The call timeout covers that wait.
        if (lost.on) await deadline(ms, () => pool.sql.unsafe("select 1"), pool.sql).catch(discard);
        else reserved.release();
      }
    },
  };
}

export async function describe(
  sql: Sql,
  text: string,
  params?: readonly WireValue[],
): Promise<DescribeResult> {
  const d = await sql.unsafe(text, asParams(params), { prepare: true }).describe();
  const fields = d.columns.map((c) => ({
    name: c.name,
    typeOid: c.type,
    tableOid: c.table,
    attnum: c.number,
  }));
  return {
    columns: fields.map((c) => c.name),
    parameterCount: d.types.length,
    parameters: d.types,
    fields,
  };
}

export async function* stream(
  sql: Sql,
  text: string,
  params?: readonly WireValue[],
): AsyncIterable<readonly (readonly WireValue[])[]> {
  for await (const chunk of sql.unsafe(text, asParams(params)).cursor(64)) yield rowsFrom(chunk);
}

type ReservedConnection = Sql & {
  release(): void;
};

type Wait = { s: () => void; a: () => void };

type Opts = {
  readonly max: number;
  onclose?: (id: number) => void;
  q?: Set<Wait>;
  n?: Set<number>;
};

/**
 * Waits for one pool.
 *
 * postgres.js calls `options.onclose(id)`. A wait with no call timeout is
 * rejected only after every slot has closed. One close retries a queued
 * reserve, because the driver takes that reserve off its queue and drops it.
 * A wait on a reserved connection uses that connection's own `onclose`.
 *
 * @param sql - The pool client
 * @returns Pool options, or `undefined` for a reserved connection
 */
function poolWaits(sql: Sql): Opts | undefined {
  const options = (sql as { options?: Opts }).options;
  if (options === undefined || options.q !== undefined) return options;
  const q = new Set<Wait>();
  const n = new Set<number>();
  options.q = q;
  options.n = n;
  options.onclose = (id: number) => {
    n.add(id);
    if (n.size < options.max) {
      queueMicrotask(() => {
        for (const w of q) w.a();
      });
      return;
    }
    n.clear();
    for (const w of q) w.s();
    q.clear();
  };
  return options;
}

/**
 * Settles `run` when `ms` elapses, the reserved connection closes, or every
 * slot in the pool has closed.
 *
 * A positive `ms` rejects with `timeout` and does not use the pool close hook.
 * `link` is the reserved connection's lost flag, or the pool client.
 *
 * @param ms - Deadline in milliseconds. `0` waits for a close
 * @param run - Driver operation
 * @param link - Connection flag, or the pool client when the wait has no connection
 * @returns The operation's value
 */
export function deadline<T>(ms: number, run: () => Promise<T>, link?: Lost | Sql): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let off = discard;
  const slot = link !== undefined && "stop" in link ? link : undefined;
  const pool = slot === undefined && link !== undefined ? poolWaits(link as Sql) : undefined;
  let ended = false;
  return new Promise<T>((resolve, reject) => {
    const fail = (error: unknown): void => {
      if (ended) return;
      ended = true;
      reject(error);
    };
    const stop = (): void => {
      fail(new DriverError("Connection closed", { sqlstate: "08006" }));
    };
    if (slot !== undefined) slot.stop = stop;
    const go = (): void => {
      const pending = run() as Promise<T> & { cancel?: () => void };
      if (ms > 0 && timer === undefined) {
        timer = setTimeout(() => {
          pending.cancel?.();
          fail(timedOut());
        }, ms);
      }
      void pending.then((value) => {
        if (ended) {
          (value as { release?: () => void }).release?.();
          return;
        }
        ended = true;
        pool?.n?.clear();
        resolve(value);
      }, fail);
    };
    if (ms === 0 && pool?.q !== undefined) {
      let used = false;
      const wait: Wait = {
        s: stop,
        a() {
          if (used || ended) return;
          used = true;
          go();
        },
      };
      pool.q.add(wait);
      off = () => pool.q?.delete(wait);
    }
    go();
  }).finally(() => {
    clearTimeout(timer);
    if (slot !== undefined) slot.stop = discard;
    off();
  });
}

/**
 * Checks out one connection, runs one batch, and releases it.
 *
 * The call timeout covers acquiring the connection and clearing it on release.
 *
 * @param pool - The open pool
 * @param statements - Statements in order
 * @param options - Call timeout and signal
 * @returns One result per statement
 */
export async function runBatch(
  pool: HeldPool,
  statements: readonly Statement[],
  options: ExecuteOptions | undefined,
): Promise<readonly ExecuteResult[]> {
  const connection = await checkout(pool, options?.timeout);
  try {
    return await connection.batch(statements, options);
  } finally {
    await connection.release();
  }
}

function reserveConnection(
  sql: Sql,
  acquireMs: number | undefined,
  counters: Counters,
  callMs: number | undefined,
): Promise<ReservedConnection> {
  counters.waiting += 1;
  let settled = false;
  const finish = (): void => {
    counters.waiting = Math.max(0, counters.waiting - 1);
  };
  return new Promise((resolve, reject) => {
    const timer =
      acquireMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) return;
            settled = true;
            finish();
            void driverErrors().then((errors) => {
              reject(errors.acquireTimeout());
            });
          }, acquireMs);
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      finish();
      fn();
    };
    void deadline(callMs !== undefined && callMs > 0 ? callMs : 0, () => sql.reserve(), sql).then(
      (connection) => {
        if (settled) {
          void resetConnection(connection, 0)
            .catch(discard)
            .finally(() => {
              connection.release();
            });
          return;
        }
        done(() => {
          resolve(connection);
        });
      },
      (error: unknown) => {
        done(() => {
          void mapFailure(error).then(reject);
        });
      },
    );
  });
}

async function resetConnection(sql: Sql, depth: number): Promise<void> {
  if (depth > 0) await sql.unsafe("ROLLBACK").catch(discard);
  const clear = async (): Promise<void> => {
    await sql.unsafe(RESET_ALL);
    await sql.unsafe(UNLOCK);
  };
  try {
    await clear();
  } catch {
    await sql.unsafe("ROLLBACK").catch(discard);
    await clear();
  }
}

const asParams = (params?: readonly WireValue[]): string[] => (params ?? []) as unknown as string[];

/**
 * Sets `lost` when the reserved socket closes.
 *
 * The first statement installs `onclose`. Later statements see the flag
 * before they write.
 *
 * @param sql - Reserved connection
 * @param lost - Set when that socket closes
 */
function arm(sql: Sql, lost: Lost): void {
  const unsafe = sql.unsafe.bind(sql);
  sql.unsafe = ((text: string, params?: unknown, options?: object) =>
    unsafe(
      text,
      params as never,
      {
        ...options,
        onexecute(connection: { onclose: (() => void) | null }) {
          connection.onclose = () => {
            lost.on = true;
            lost.stop();
          };
        },
      } as never,
    )) as Sql["unsafe"];
}

/** @inheritdoc */
export const watchReserved = arm;

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
    connection.release = () =>
      released ? Promise.resolve() : ((released = true), release().finally(() => gate.leave()));
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
      await stop().finally(() => {
        gate.leave();
      });
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
  const done = (): void => {
    ctx.leave();
    ctx.untrack(pending);
    watch.signal.removeEventListener("abort", onAbort);
  };
  return pending.then(
    (value) => {
      done();
      const why = watch.reason();
      if (why === "timeout" || why === "cancelled") return classify(why, watch);
      ctx.note(ctx.text);
      return resultFrom(value, ctx.notices.since(ctx.start));
    },
    (error: unknown) => {
      done();
      return classify(error, watch);
    },
  );
}

async function classify(error: unknown, watch: Watch): Promise<never> {
  const errors = await driverErrors();
  if (error instanceof errors.DriverError) throw error;
  const why = typeof error === "string" ? error : watch.reason();
  const cause = typeof error === "string" ? undefined : error;
  if (why === "timeout") throw errors.timedOut(cause);
  if (why === "cancelled" || errors.errorField(error, "code") === "57014") {
    throw errors.cancelled(cause);
  }
  throw errors.mapDriverError(error);
}
