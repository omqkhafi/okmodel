/**
 * Reserved connections for node-postgres.
 *
 * Loaded on the first reserve, batch, or stream. A read does not use it.
 */

import type { PoolClient } from "pg";

import { isConnectionLost } from "../../contracts/connection.js";
import type { DriverConnection } from "../../contracts/driver.js";
import { rejectClosed } from "../failure.js";
import { runCall, type Watch } from "./call.js";
import { connectClient, send, type HeldPool } from "./nodepostgres.js";
import { WireSession, type WireQuery } from "./session.js";

const RESET_ALL = "RESET ALL";
const UNLOCK = "SELECT pg_advisory_unlock_all()";

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
    (text, params) => send(client, text, params, named, client),
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
  const run = (text: string): Promise<unknown> => client.query(text);
  if (session.depth() > 0) await run("ROLLBACK").catch(() => undefined);
  try {
    await run(RESET_ALL);
    await run(UNLOCK);
  } catch {
    await run("ROLLBACK").catch(() => undefined);
    await run(RESET_ALL);
    await run(UNLOCK);
  }
}
