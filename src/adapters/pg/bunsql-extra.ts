/**
 * Reserved connections for Bun.sql.
 *
 * Loaded on the first reserve, batch, or stream. A read does not use it.
 */

import type { SQL } from "bun";

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
export async function checkout(held: HeldPool): Promise<DriverConnection> {
  const { counters, isClosed } = held;
  if (isClosed()) return rejectClosed();
  const reserved = held.parked.pop() ?? (await reserve(held.sql, held.acquireMs, counters));
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
      return guard(() =>
        runCall(isClosed(), options, (watch) => session.query(text, params, watch)),
      );
    },
    batch: (statements, options) => {
      const refused = noTimeout(options);
      if (refused !== undefined) return refused;
      return guard(() =>
        runCall(isClosed(), options, async (watch: Watch | undefined) => {
          const { runAtomicBatch } = await import("./batch.js");
          return runAtomicBatch(session, statements, watch);
        }),
      );
    },
    async release() {
      if (released) return;
      released = true;
      try {
        if (!lost.on) await reset(session, reserved);
      } finally {
        counters.reserved = Math.max(0, counters.reserved - 1);
        // A closed Bun.sql connection rejects the next statement with
        // "Connection closed". A discarded statement takes that rejection.
        if (lost.on) await held.sql.unsafe("select 1").catch(() => undefined);
        else await park(held.parked, reserved);
      }
    },
  };
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
