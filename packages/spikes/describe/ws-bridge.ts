/**
 * Transparent WebSocket-to-TCP bridge for the Neon WebSocket driver.
 *
 * `@neondatabase/serverless` speaks the Postgres wire protocol over a
 * WebSocket. Local Postgres does not. The bridge copies bytes and does not
 * parse them. Throwaway spike code.
 */

import { connect as connectTcp, type Socket } from "node:net";

/** A bridge bound on 127.0.0.1. */
export type WsBridge = {
  /** Port Neon should use as `wsProxy`. */
  readonly port: number;
  /** Stops listening and closes open sockets. */
  stop(): void;
};

type SocketData = {
  socket?: Socket;
};

/**
 * Forwards binary WebSocket frames to one Postgres port.
 *
 * @param host - Postgres host
 * @param pgPort - Postgres port
 * @returns The local listen port
 */
export function startBridge(host: string, pgPort: number): WsBridge {
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, bun) {
      const upgraded = bun.upgrade(req, { data: {} });
      return upgraded ? undefined : new Response("websocket", { status: 426 });
    },
    websocket: {
      open(ws) {
        const socket = connectTcp(pgPort, host);
        ws.data.socket = socket;
        socket.on("data", (chunk: Buffer) => {
          ws.send(chunk);
        });
        socket.on("close", () => {
          ws.close();
        });
        socket.on("error", () => {
          ws.close();
        });
      },
      message(ws, message) {
        const socket = ws.data.socket;
        if (socket === undefined) return;
        const bytes = typeof message === "string" ? Buffer.from(message) : Buffer.from(message);
        socket.write(bytes);
      },
      close(ws) {
        ws.data.socket?.end();
      },
    },
  });
  return {
    port: server.port ?? 0,
    stop() {
      void server.stop(true);
    },
  };
}
