/**
 * Reserved connections for Bun.sql.
 *
 * Loaded on the first reserve, batch, stream, or dead connection. A read that
 * succeeds does not use it.
 */

import type { ReservedSQL, SQL } from "./bun-sql.js";

import { isConnectionFailure } from "../../contracts/connection.js";
import type { DriverConnection, WireValue } from "../../contracts/driver.js";
import { DriverError } from "../error.js";
import { rejectClosed } from "../failure.js";
import { runCall, type Watch } from "./call.js";
import { noTimeout } from "./no-inflight-timeout.js";
import { park, reserve, send, type HeldPool } from "./bunsql.js";
import { refuseWhenLost, resetSession, type Lost } from "./reserved.js";
import { cursorStream } from "./cursor.js";
import { WireSession } from "./session.js";

/**
 * Checks out one connection and clears it on release.
 *
 * A connection that is gone is neither reset nor parked: Bun.sql has already
 * dropped it, and parking it would hand a dead session to the next caller.
 *
 * @param held - The pool and its counters
 * @returns A connection the caller must release
 */
/**
 * Drops a dead pooled socket, then runs `again` once when that is safe.
 *
 * A `57P01` or a socket Bun has already closed is evicted before another
 * statement can take it. A client read is tried once more when `depth` is 0.
 * A raw pool retries only when the socket had already closed, or Bun rejected
 * the statement before the server saw it, so a query killed while it was
 * running is not started again. `again` does not pass through `recover`.
 *
 * @param sql - The pool
 * @param error - The failure from the first attempt
 * @param text - Statement text, used to decide the retry
 * @param depth - Open transaction depth. Above zero, an earlier command was sent
 * @param clientRead - The pool was opened for a client, which retries a read once
 * @param closedDuring - `onclose` ran after this statement was sent
 * @param again - The same statement, on whatever connection the pool hands out next
 * @returns The retried result, or a rejection of `error`
 */
export async function recover<T>(
  sql: SQL,
  error: unknown,
  text: string,
  depth: number,
  clientRead: boolean,
  closedDuring: boolean,
  again: () => Promise<T>,
): Promise<T> {
  if (!lostQuery(error)) throw error;
  await flushClosed(sql);
  const alreadyDead = closedDuring || socketClosed(error);
  if ((!clientRead && !alreadyDead) || depth !== 0 || !readStatement(text)) throw error;
  try {
    return await again();
  } catch (next) {
    if (lostQuery(next)) await flushClosed(sql);
    throw next;
  }
}

/**
 * Spends a closed socket before the caller's statement is sent.
 *
 * @param sql - The pool
 */
export function drainClosed(sql: SQL): Promise<void> {
  return flushClosed(sql).then(() => undefined);
}

/**
 * A read, under the same classification the topology uses for its one retry.
 *
 * Transaction control, writes, and locks are not retried.
 *
 * @param text - Statement text
 * @returns `true` when running the statement again cannot repeat a write
 */
function readStatement(text: string): boolean {
  const head = text.trimStart().toLowerCase().replace(/\s+/g, " ");
  if (head.length === 0 || head.includes("pg_advisory")) return false;
  if (/\sfor (?:no key update|key share|update|share)\b/.test(head)) return false;
  return !/^(?:insert|update|delete|refresh|with|create|alter|drop|truncate|grant|revoke|comment|vacuum|analyze|reindex|copy|begin|start|commit|rollback|savepoint|release|set|reset)\b/.test(
    head,
  );
}

function lostQuery(error: unknown): boolean {
  return isConnectionFailure(error) || socketClosed(error);
}

function socketClosed(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "Connection closed") return true;
  return error.cause instanceof Error && error.cause.message === "Connection closed";
}

/**
 * Subscribes on one pooled connection.
 *
 * @param sql - The pool
 * @param parked - Reserved handles to put back first
 * @param closed - The pool is closed
 * @param channel - Notify channel
 * @param onNotify - Payload callback
 * @returns Stops the subscription
 */
export async function listen(
  sql: SQL,
  parked: ReservedSQL[],
  closed: boolean,
  channel: string,
  onNotify: (payload: string) => void,
): Promise<() => Promise<void>> {
  if (closed) return rejectClosed();
  const pending = parked.splice(0);
  for (const reserved of pending) {
    const done: unknown = reserved.release();
    if (done instanceof Promise) await done;
  }
  const subscription = await sql.listen(channel, onNotify);
  return async () => {
    await subscription.unlisten();
  };
}

export async function checkout(held: HeldPool): Promise<DriverConnection & { evict(): void }> {
  const { counters, isClosed } = held;
  if (isClosed()) return rejectClosed();
  const reserved = (await takeOpen(held)) ?? (await reserve(held.sql, held.acquireMs, counters));
  counters.reserved += 1;
  const session = new WireSession(
    (text, params) => send(reserved, text, params),
    held.notices,
    isClosed,
    false,
    () => {
      counters.reservedBusy += 1;
    },
    () => {
      counters.reservedBusy = Math.max(0, counters.reservedBusy - 1);
    },
  );
  let lost: Lost = { on: false };
  // Snapshotted after the handle is reserved. A later close means this handle
  // may already be a new connection, without the transaction or the tenant GUC.
  const opened = held.closures();
  const reconnected = (): Promise<never> | undefined => {
    if (held.closures() === opened) return undefined;
    lost.on = true;
    return Promise.reject(new DriverError("Connection closed", { sqlstate: "08006" }));
  };
  const guard = <T>(run: () => Promise<T>): Promise<T> =>
    refuseWhenLost(lost, () =>
      run().catch((error: unknown) => {
        // Bun.sql sends no code for a handle that is already gone. These two
        // texts are the whole signal. The stamp is a SQLSTATE, which is what
        // the classifier reads.
        if (error instanceof Error && bunClosed(error.message)) {
          throw new DriverError(error.message, { cause: error, sqlstate: "08006" });
        }
        throw error;
      }),
    );
  let released = false;
  return {
    execute: (text, params, options) => {
      const refused = noTimeout(options);
      if (refused !== undefined) return refused;
      const gone = reconnected();
      if (gone !== undefined) return gone;
      return guard(() =>
        runCall(isClosed(), options, (watch) => session.query(text, params, watch)),
      );
    },
    batch: (statements, options) => {
      const refused = noTimeout(options);
      if (refused !== undefined) return refused;
      const gone = reconnected();
      if (gone !== undefined) return gone;
      return guard(() =>
        runCall(isClosed(), options, async (watch: Watch | undefined) => {
          const { runAtomicBatch } = await import("./batch.js");
          return runAtomicBatch(session, statements, watch);
        }),
      );
    },
    evict() {
      lost.on = true;
    },
    async release() {
      if (released) return;
      released = true;
      if (!lost.on && reportsClosed(reserved)) lost.on = true;
      try {
        if (!lost.on) await reset(session, reserved);
      } catch (error) {
        if (lostQuery(error) || reportsClosed(reserved)) lost.on = true;
        else throw error;
      } finally {
        counters.reserved = Math.max(0, counters.reserved - 1);
        // A closed Bun.sql connection rejects the next statement with
        // "Connection closed". A discarded statement takes that rejection.
        if (lost.on) {
          // The slot has to be free before the pool can open a new connection.
          // Releasing a closed handle puts it back once; flush spends that failure.
          try {
            reserved.release();
          } catch {
            // Bun already dropped the handle.
          }
          await flushClosed(held.sql);
        } else await park(held.parked, reserved);
      }
    },
  };
}

/**
 * A parked connection Bun has already closed.
 *
 * @param reserved - The handle about to be reused
 * @returns `true` when the handle reports itself closed
 */
function reportsClosed(reserved: ReservedSQL): boolean {
  return Reflect.get(reserved, "closed") === true;
}

/**
 * Drops parked connections that report closed, then returns one that is open.
 *
 * A closed handle is not released back into Bun's pool. A discarded statement
 * takes the rejection so the next checkout does not see it.
 *
 * @param held - The pool and its parked handles
 * @returns An open handle, or `undefined` when the park is empty
 */
async function takeOpen(held: HeldPool): Promise<ReservedSQL | undefined> {
  while (held.parked.length > 0) {
    const next = held.parked.pop();
    if (next === undefined) return undefined;
    if (!reportsClosed(next)) return next;
    try {
      next.release();
    } catch {
      // Bun already dropped the handle.
    }
    await flushClosed(held.sql);
  }
  return undefined;
}

/**
 * Spends the one failure a closed Bun.sql socket reports, then stops.
 *
 * The next statement on that pool opens a new connection. Three tries cover
 * a socket that fails once and a second that is already open.
 *
 * @param sql - The pool
 * @returns `true` when a statement got a live connection
 */
async function flushClosed(sql: SQL): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await sql.unsafe("select 1");
      return true;
    } catch {
      // The closed socket rejects once.
    }
  }
  return false;
}

function bunClosed(message: string): boolean {
  return (
    message === "Connection closed" || message === "connection must be a PostgresSQLConnection"
  );
}

async function reset(session: WireSession, sql: SQL): Promise<void> {
  const run = (text: string): Promise<unknown> => sql.unsafe(text);
  await resetSession(session.depth(), run);
}

/**
 * Yields cursor chunks from one checked-out Bun.sql connection.
 *
 * @param checkout - Reserves the connection
 * @param text - Query to stream
 * @param params - Wire parameters
 * @returns Chunks of wire rows
 */
export function streamRows(
  checkout: () => Promise<DriverConnection & { evict?: () => void }>,
  text: string,
  params: readonly WireValue[] | undefined,
): AsyncIterable<readonly (readonly WireValue[])[]> {
  return (async function* () {
    const connection = await checkout();
    try {
      yield* cursorStream(
        (statement, values) => connection.execute(statement, values),
        text,
        params,
      );
    } catch (error) {
      connection.evict?.();
      throw error;
    } finally {
      await connection.release();
    }
  })();
}
