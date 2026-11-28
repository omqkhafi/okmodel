/**
 * The node-postgres listen connection.
 *
 * `okmodel/pg/pg` registers this opener. A postgres.js bundle does not load it,
 * so that app does not pull in the `pg` package.
 */

import type { ListenNotify, ListenSocket } from "./client.js";
import { quoteChannel } from "./listen-socket.js";

type PgClient = {
  connect(): Promise<void>;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: "error", listener: (error: unknown) => void): void;
  on(
    event: "notification",
    listener: (message: { channel: string; payload?: string }) => void,
  ): void;
};

/**
 * Opens one node-postgres client for `LISTEN`.
 *
 * `error` is handled here. The connection's `application_name` is `okm-listen`.
 *
 * @param url - Direct Postgres URL
 * @param onNotify - Called for each notification
 * @param onLost - Called when the client errors
 * @returns The socket
 */
export async function openPgListen(
  url: string,
  onNotify: ListenNotify,
  onLost: (error: unknown) => void,
): Promise<ListenSocket> {
  const pg = (await import("pg")).default as unknown as {
    Client: new (config: { connectionString: string; application_name: string }) => PgClient;
  };
  const client = new pg.Client({ connectionString: url, application_name: "okm-listen" });
  let lost = false;
  client.on("error", (error) => {
    if (lost) return;
    lost = true;
    onLost(error);
  });
  client.on("notification", (message) => {
    onNotify(message.channel, message.payload ?? "");
  });
  await client.connect();
  return {
    listen(channel) {
      return client.query(`LISTEN ${quoteChannel(channel)}`).then(() => undefined);
    },
    query(text, timeoutMs) {
      return withTimeout(
        client.query(text).then(() => undefined),
        timeoutMs,
      );
    },
    async close() {
      lost = true;
      await client.end();
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
