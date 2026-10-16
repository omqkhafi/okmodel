/**
 * Reserved connections for the Neon WebSocket pool.
 *
 * Loaded on the first reserve or batch. A read does not use it.
 */

import type { PoolClient } from "@neondatabase/serverless";

import { isConnectionLost } from "../../contracts/connection.js";
import type { DriverConnection } from "../../contracts/driver.js";
import { DriverError } from "../error.js";
import { rejectClosed } from "../failure.js";
import { runCall, type Watch } from "./call.js";
import { noTimeout } from "./no-inflight-timeout.js";
import { connectClient, send, type HeldPool } from "./neon.js";
import { resetSession } from "./reserved.js";
import { WireSession, type WireQuery } from "./session.js";

/**
 * Checks out one client and clears it on release.
 *
 * A client whose connection is gone is destroyed on release, and nothing more
 * is sent to it. A checked-out client has no pool error listener, so one is
 * set here: without it a dropped socket is an uncaught `error` event.
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
      const pending = send(client, text, params, named);
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
      return guarded;
    },
    held.notices,
    isClosed,
    false,
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
