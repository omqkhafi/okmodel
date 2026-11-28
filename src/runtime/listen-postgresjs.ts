/**
 * The postgres.js listen connection.
 *
 * Loaded from `okmodel/pg/postgresjs` only. `sql.listen` hides its socket
 * inside another client, so the heartbeat runs `SELECT 1` on this `max: 1`
 * connection. `application_name` is `okm-listen`.
 */

import type { ListenNotify, ListenSocket } from "./client.js";
import { quoteChannel } from "./listen-socket.js";

type SqlClient = {
  unsafe(text: string): Promise<unknown>;
  end(options?: { readonly timeout?: number }): Promise<void>;
};

/**
 * Opens the postgres.js listen connection.
 *
 * @param url - Direct Postgres URL
 * @param onNotify - Called for each notification
 * @param onLost - Called when the socket errors or closes
 * @returns The socket
 */
export async function openPostgresJsListen(
  url: string,
  onNotify: ListenNotify,
  onLost: (error: unknown) => void,
): Promise<ListenSocket> {
  const postgres = (await import("postgres")).default as (
    target: string,
    options: Record<string, unknown>,
  ) => SqlClient;
  let lost = false;
  const sql = postgres(url, {
    max: 1,
    idle_timeout: null,
    max_lifetime: null,
    fetch_types: false,
    no_subscribe: true,
    connection: { application_name: "okm-listen" },
    onnotify: (channel: string, payload: string) => {
      onNotify(channel, payload ?? "");
    },
    onclose: () => {
      if (lost) return;
      lost = true;
      onLost(new Error("The listen connection closed."));
    },
  });
  return {
    listen(channel) {
      return sql.unsafe(`LISTEN ${quoteChannel(channel)}`).then(() => undefined);
    },
    query(text, timeoutMs) {
      return withTimeout(
        sql.unsafe(text).then(() => undefined),
        timeoutMs,
      );
    },
    async close() {
      lost = true;
      await sql.end({ timeout: 5 });
    },
  };
}

function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The listen heartbeat timed out.")), timeoutMs);
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
