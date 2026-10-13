/**
 * Reserved connections for node-postgres.
 *
 * Loaded on the first reserve, batch, or stream. A read does not use it.
 */

import type { PoolClient } from "pg";

import { isConnectionLost } from "../../contracts/connection.js";
import type { DriverConnection, WireValue } from "../../contracts/driver.js";
import { DriverError } from "../error.js";
import { rejectClosed } from "../failure.js";
import { runCall, type Watch } from "./call.js";
import { armDriverError, connectClient, send, type HeldPool } from "./nodepostgres.js";
import { resetSession } from "./reserved.js";
import { cursorStream } from "./cursor.js";
import { WireSession, type WireQuery } from "./session.js";

/**
 * Checks out one client and clears it on release.
 *
 * A client whose connection is gone is destroyed on release, and nothing more is
 * sent to it. A checked-out client has no pool error listener, so one is set here:
 * without it a dropped socket is an uncaught `error` event.
 *
 * @param held - The pool and its counters
 * @returns A connection the caller must release
 */
export async function checkout(held: HeldPool): Promise<DriverConnection> {
  const { pool, counters, named, isClosed } = held;
  if (isClosed()) return rejectClosed();
  const client = await connectClient(pool, held.acquireMs, counters);
  counters.reserved += 1;
  let lost = false;
  const onError = (): void => {
    lost = true;
  };
  const events = client as unknown as {
    on(event: "error", listener: () => void): void;
    removeListener(event: "error", listener: () => void): void;
  };
  events.on("error", onError);
  const local = new Set<WireQuery>();
  const session = new WireSession(
    (text, params) => {
      const pending = send(client, text, params, named, client);
      // node-postgres rejects a cut socket with a plain Error and no code.
      // The client's `error` event has already set `lost`. The message is not read.
      const guarded = pending.catch((error: unknown) => {
        if (isConnectionLost(error) || lost) {
          lost = true;
          if (isConnectionLost(error)) throw error;
          throw Object.assign(new DriverError("CONNECTION_CLOSED", { cause: error }), {
            code: "CONNECTION_CLOSED",
          });
        }
        throw error;
      }) as WireQuery;
      guarded.cancel = () => {
        pending.cancel?.();
      };
      return guarded;
    },
    held.notices,
    isClosed,
    true,
    () => {
      counters.reservedBusy += 1;
    },
    () => {
      counters.reservedBusy = Math.max(0, counters.reservedBusy - 1);
    },
    local,
  );
  const guard = <T>(run: () => Promise<T>): Promise<T> => (lost ? rejectClosed() : run());
  let released = false;
  return {
    execute: (text, params, options) =>
      guard(() => runCall(isClosed(), options, (watch) => session.query(text, params, watch))),
    batch: (statements, options) =>
      guard(() =>
        runCall(isClosed(), options, async (watch: Watch | undefined) => {
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
        if (!lost) await reset(session, client);
      } finally {
        counters.reserved = Math.max(0, counters.reserved - 1);
        events.removeListener("error", onError);
        client.release(lost);
      }
    },
  };
}

async function reset(session: WireSession, client: PoolClient): Promise<void> {
  await resetSession(session.depth(), (text) => client.query(text));
}

/**
 * Listens on one checked-out client.
 *
 * The client has no pool error listener. One is set here so a dropped socket
 * is not an uncaught `error` event.
 *
 * @param held - The pool and its counters
 * @param channel - Notification channel
 * @param onNotify - Called with each payload
 * @returns Stops the listener
 */
export async function listen(
  held: HeldPool,
  channel: string,
  onNotify: (payload: string) => void,
): Promise<() => Promise<void>> {
  const { pool, counters } = held;
  const client = await connectClient(pool, held.acquireMs, counters);
  counters.reserved += 1;
  const quoted = quoteIdent(channel);
  const onNotification = (message: { channel: string; payload?: string }): void => {
    if (message.channel === channel) onNotify(message.payload ?? "");
  };
  client.on("notification", onNotification);
  let released = false;
  const release = (dead?: unknown): void => {
    if (released) return;
    released = true;
    client.removeListener("notification", onNotification);
    (
      client as unknown as { removeListener(event: "error", listener: typeof release): void }
    ).removeListener("error", release);
    counters.reserved = Math.max(0, counters.reserved - 1);
    client.release(Boolean(dead));
  };
  armDriverError(client, release);
  try {
    await client.query(`LISTEN ${quoted}`);
  } catch (error) {
    release(false);
    throw error;
  }
  return async () => {
    if (released) return;
    try {
      await client.query(`UNLISTEN ${quoted}`);
    } finally {
      release(false);
    }
  };
}

/**
 * Yields cursor chunks from one checked-out client.
 *
 * @param checkout - Reserves the connection
 * @param text - Query to stream
 * @param params - Wire parameters
 * @returns Chunks of wire rows
 */
export function streamRows(
  checkout: () => Promise<DriverConnection>,
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
    } finally {
      await connection.release();
    }
  })();
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
