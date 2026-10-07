import { createServer, connect, type Server, type Socket } from "node:net";

/** A TCP relay that delays bytes from the server before the client sees them. */
export type DelayProxy = {
  /** Connection URL for a client that goes through the relay. */
  readonly url: string;
  /** Closes the relay and every socket it holds. */
  close(): Promise<void>;
};

/**
 * Relays `target` and holds each server chunk for `delayMs` before writing it.
 *
 * Client bytes are forwarded immediately. The delay is the extra round-trip a
 * replica read or a health probe pays.
 *
 * @param target - Upstream URL, for example a replica `postgres://` URL
 * @param delayMs - How long to hold each server chunk
 * @returns The relay
 */
export async function startDelayProxy(target: string, delayMs: number): Promise<DelayProxy> {
  const upstream = new URL(target);
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const remote = connect({ host: upstream.hostname, port: Number(upstream.port) });
    sockets.add(client).add(remote);
    client.on("data", (chunk: Buffer) => {
      if (!remote.destroyed) remote.write(chunk);
    });
    remote.on("data", (chunk: Buffer) => {
      setTimeout(() => {
        if (!client.destroyed) client.write(chunk);
      }, delayMs);
    });
    for (const socket of [client, remote]) {
      socket.on("error", () => {
        client.destroy();
        remote.destroy();
      });
      socket.on("close", () => sockets.delete(socket));
    }
    client.on("close", () => remote.end());
    remote.on("close", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return {
    url: url.toString(),
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A TCP relay in front of the topology primary that can cut a commit. */
export type CutProxy = {
  /** Connection URL for a client that goes through the relay. */
  readonly url: string;
  /**
   * The next COMMIT a client sends is passed to the server. The answer is held
   * back and the client socket is destroyed. The commit lands, and the client
   * never learns that.
   */
  cutNextCommit(): void;
  /** Closes the relay and every socket it holds. */
  close(): Promise<void>;
};

/**
 * Starts a relay to `target` on a free local port.
 *
 * It exists for one case: a connection that dies while COMMIT is on the wire.
 * The relay looks for the bytes `COMMIT` in what the client sends, so a test
 * that arms it must not write that word in its data.
 *
 * @param target - Primary URL, for example `postgres://okm:okm@127.0.0.1:55432/okm`
 * @returns The relay
 */
export async function startCutProxy(target: string): Promise<CutProxy> {
  const upstream = new URL(target);
  let armed = false;
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const remote = connect({ host: upstream.hostname, port: Number(upstream.port) });
    let cut = false;
    sockets.add(client).add(remote);
    client.on("data", (chunk: Buffer) => {
      if (armed && chunk.includes("COMMIT")) {
        armed = false;
        cut = true;
        // Hold the answer back and drop the client a moment later, once the driver has finished writing.
        setTimeout(() => client.destroy(), 25);
      }
      remote.write(chunk);
    });
    remote.on("data", (chunk: Buffer) => {
      if (!cut && !client.destroyed) client.write(chunk);
    });
    for (const socket of [client, remote]) {
      socket.on("error", () => {
        client.destroy();
        remote.destroy();
      });
      socket.on("close", () => sockets.delete(socket));
    }
    // A closing client ends the server side gracefully, so a COMMIT already written is processed.
    client.on("close", () => remote.end());
    remote.on("close", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return {
    url: url.toString(),
    cutNextCommit() {
      armed = true;
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
