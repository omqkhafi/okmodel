/**
 * Neon adapter (`okmodel/pg/neon`).
 *
 * `@neondatabase/serverless` is an optional peer. This module is the only
 * place that imports it. `mode: "websocket"` (the default) is a pooled
 * WebSocket client with interactive transactions. `mode: "http"` is one HTTP
 * request per statement, and `batch` is the driver's non-interactive
 * transaction. A positive `timeout` is refused: neither mode aborts a
 * statement the server has already started.
 *
 * The first WebSocket `open` sets `webSocketConstructor` only when it is
 * still unset, so a caller can install one first. A transaction-mode pooler
 * does not promise session state. One small compute can reuse a backend, so
 * a custom `SET`, `LISTEN`, or a prepared statement may still be visible.
 */

import { Pool, neonConfig, type PoolClient } from "@neondatabase/serverless";

import type {
  DriverConnection,
  DriverPool,
  DriverPoolConfig,
  DriverStats,
  WireValue,
} from "../../contracts/driver.js";
import { NEON_WEBSOCKET_CAPABILITIES } from "../capabilities.js";
import { driverErrors, mapFailure } from "../failure.js";
import { runCall } from "./call.js";
import { idleMs } from "./idle-ms.js";
import { noTimeout } from "./no-inflight-timeout.js";
import { noticeBuffer, WireSession, type WireQuery } from "./session.js";

export {
  NEON_WEBSOCKET_CAPABILITIES as capabilities,
  NEON_HTTP_CAPABILITIES as httpCapabilities,
  hasCapability,
  readCapability,
} from "../capabilities.js";
export { DriverError } from "../error.js";

/** How {@link open} talks to Neon. */
export type NeonMode = "websocket" | "http";

/** Options for {@link open}. */
export type NeonConfig = DriverPoolConfig & {
  /** Connection URL for this endpoint. */
  readonly url: string;
  /**
   * `websocket` is a pooled WebSocket client. `http` is one-shot HTTP.
   *
   * Omitted means `websocket`.
   */
  readonly mode?: NeonMode;
  /**
   * How long a WebSocket pool connection may sit idle before it closes.
   *
   * Milliseconds. Omitted means 30 seconds. `0` keeps idle connections until
   * the pool closes. HTTP mode refuses an explicit value with OKM1120.
   */
  readonly idleTimeoutMs?: number;
  /**
   * Named prepared statements, or the unnamed protocol.
   *
   * Unnamed is the default. It stays valid behind a pooler in transaction mode.
   * `prepared: "named"` is not for transaction-mode poolers. HTTP ignores it.
   */
  readonly prepared?: "named" | "unnamed";
  /** Session search path for every WebSocket connection in the pool. */
  readonly searchPath?: string;
};

/** Pool occupancy. */
export type Counters = {
  reserved: number;
  busy: number;
  reservedBusy: number;
  waiting: number;
};

/** What a WebSocket checkout needs from the pool that opened it. */
export type HeldPool = {
  readonly pool: Pool;
  readonly acquireMs: number | undefined;
  readonly counters: Counters;
  readonly notices: ReturnType<typeof noticeBuffer>;
  readonly named: boolean;
  readonly isClosed: () => boolean;
};

/** A client that can run one array-mode statement. */
type Queryable = {
  query(config: {
    text: string;
    values?: readonly WireValue[];
    rowMode: "array";
    types: typeof WIRE;
    name?: string;
  }): Promise<unknown>;
};

const CONNECT_MS = 30_000;

export const WIRE = {
  getTypeParser(): (value: string) => string {
    return (value) => value;
  },
};

const names = new Map<string, string>();

/**
 * Opens a Neon pool for one endpoint.
 *
 * WebSocket mode connects once before returning, so a later short acquire
 * timeout measures the queue and not a cold start. HTTP mode does not open a
 * socket.
 *
 * @param config - URL, mode, pool size, and acquire timeout
 * @returns The pool
 */
export async function open(config: NeonConfig): Promise<DriverPool> {
  if (config.mode === "http") {
    if (config.idleTimeoutMs != null) {
      return import("../lazy-errors.js").then((mod) => mod.refused());
    }
    return import("./neon-http.js").then((mod) => mod.openHttp(config));
  }
  return openWebSocket(config);
}

/**
 * Checks out one WebSocket client.
 *
 * The wait uses `timeouts.acquire`. A timeout is OKM1846 and does not keep the
 * client.
 *
 * @param pool - Neon pool
 * @param acquireMs - Wait ceiling, when one was set
 * @param counters - Pool occupancy
 * @returns The client
 */
export function connectClient(
  pool: Pool,
  acquireMs: number | undefined,
  counters: Counters,
): Promise<PoolClient> {
  counters.waiting += 1;
  let settled = false;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (acquireMs !== undefined) {
      timer = setTimeout(() => {
        settled = true;
        counters.waiting = Math.max(0, counters.waiting - 1);
        void driverErrors().then((errors) => {
          reject(errors.acquireTimeout());
        });
      }, acquireMs);
    }
    // The merged `Pool` overloads resolve a no-arg `connect()` to the callback form.
    take(pool).then(
      (client) => {
        if (settled) {
          client.release();
          return;
        }
        if (timer !== undefined) clearTimeout(timer);
        counters.waiting = Math.max(0, counters.waiting - 1);
        resolve(client);
      },
      (error: unknown) => {
        if (settled) return;
        if (timer !== undefined) clearTimeout(timer);
        counters.waiting = Math.max(0, counters.waiting - 1);
        void mapFailure(error).then(reject);
      },
    );
  });
}

/**
 * Sends one statement and returns the driver's promise.
 *
 * @param runner - Pool or checked-out client
 * @param text - SQL
 * @param params - Wire parameters
 * @param named - Use a named prepared statement
 * @returns The pending result
 */
export function send(
  runner: Queryable,
  text: string,
  params: readonly WireValue[] | undefined,
  named: boolean,
): WireQuery {
  const query = {
    text,
    rowMode: "array" as const,
    types: WIRE,
    ...(params !== undefined && params.length > 0 ? { values: params } : {}),
    ...(named ? { name: statementName(text) } : {}),
  };
  return runner.query(query) as WireQuery;
}

async function openWebSocket(config: NeonConfig): Promise<DriverPool> {
  ensureWebSocket();
  const max = config.max ?? 10;
  const acquireMs = config.timeouts?.acquire;
  const counters: Counters = { reserved: 0, busy: 0, reservedBusy: 0, waiting: 0 };
  const notices = noticeBuffer();
  let closed = false;
  const isClosed = (): boolean => closed;
  const named = config.prepared === "named";
  const pool = new Pool({
    connectionString: config.url,
    max,
    idleTimeoutMillis: idleMs(config.idleTimeoutMs),
    allowExitOnIdle: true,
    connectionTimeoutMillis: CONNECT_MS,
    application_name: "okmodel",
    types: WIRE,
    ...(config.searchPath !== undefined ? { options: `-c search_path=${config.searchPath}` } : {}),
  });
  pool.on("error", () => undefined);
  try {
    const warmed = await take(pool);
    warmed.release();
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw await mapFailure(error);
  }

  const root = new WireSession(
    (text, params) => send(pool, text, params, named),
    notices,
    isClosed,
    false,
    () => {
      counters.busy += 1;
    },
    () => {
      counters.busy = Math.max(0, counters.busy - 1);
    },
  );
  const held: HeldPool = { pool, acquireMs, counters, notices, named, isClosed };
  const checkout = (): Promise<DriverConnection> =>
    closed ? rejectAfterClose() : import("./neon-extra.js").then((mod) => mod.checkout(held));

  return {
    capabilities: NEON_WEBSOCKET_CAPABILITIES,
    execute(text, params, options) {
      const refused = noTimeout(options);
      if (refused !== undefined) return refused;
      if (closed) return rejectAfterClose();
      return runCall(closed, options, (watch) => root.query(text, params, watch));
    },
    async batch(statements, options) {
      const refused = noTimeout(options);
      if (refused !== undefined) return refused;
      const connection = await checkout();
      try {
        return await connection.batch(statements, options);
      } finally {
        await connection.release();
      }
    },
    reserve: () => checkout(),
    stats: () => statsOf(counters, max),
    async close() {
      closed = true;
      await pool.end();
    },
  };
}

/**
 * The promise form of `pool.connect()`.
 *
 * The published `Pool` type merges a callback overload that hides the promise.
 *
 * @param pool - Neon pool
 * @returns The checked-out client
 */
function take(pool: Pool): Promise<PoolClient> {
  const connect = pool.connect.bind(pool) as () => Promise<PoolClient>;
  return connect();
}

/**
 * Rejects a call made after `close()` with OKM1120 (not `unavailable`).
 *
 * The error text loads with the lazy module.
 *
 * @returns A rejected promise
 */
export function rejectAfterClose(): Promise<never> {
  return import("./neon-extra.js").then((mod) => mod.afterClose());
}

function ensureWebSocket(): void {
  if (neonConfig.webSocketConstructor === undefined && typeof WebSocket === "function") {
    neonConfig.webSocketConstructor = WebSocket;
  }
}

function statementName(text: string): string {
  const existing = names.get(text);
  if (existing !== undefined) return existing;
  const name = `okm_${String(names.size)}`;
  names.set(text, name);
  return name;
}

/**
 * Pool occupancy as {@link DriverStats}.
 *
 * @param counters - Pool occupancy
 * @param size - Pool size
 * @returns The stats
 */
export function statsOf(counters: Counters, size: number): DriverStats {
  return {
    size,
    idle: Math.max(0, size - counters.reserved - counters.busy),
    inflight: counters.busy + counters.reservedBusy,
    waiting: counters.waiting,
  };
}
