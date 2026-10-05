/**
 * Reserved connections for Bun.sql.
 *
 * Loaded on the first reserve, batch, or stream. A read does not use it.
 */

import type { SQL } from "bun";

import { isConnectionLost } from "../../contracts/connection.js";
import type { DriverConnection } from "../../contracts/driver.js";
import { rejectClosed } from "../failure.js";
import { runCall, type Watch } from "./call.js";
import { park, reserve, send, type HeldPool } from "./bunsql.js";
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
  let lost = false;
  const guard = <T>(run: () => Promise<T>): Promise<T> =>
    lost
      ? rejectClosed("The connection was lost.")
      : run().catch((error: unknown) => {
          if (isConnectionLost(error)) lost = true;
          throw error;
        });
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
    async release() {
      if (released) return;
      released = true;
      try {
        if (!lost) await reset(session, reserved);
      } finally {
        counters.reserved = Math.max(0, counters.reserved - 1);
        if (!lost) await park(held.parked, reserved);
      }
    },
  };
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
