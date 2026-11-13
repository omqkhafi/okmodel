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
  ExecuteOptions,
  Statement,
  WireValue,
} from "../../contracts/driver.js";
import { NEON_WEBSOCKET_CAPABILITIES } from "../capabilities.js";
import { driverErrors, mapFailure, rejectCancelled } from "../failure.js";
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

/**
 * Set on the config passed to {@link open} when the caller is bounding startup.
 *
 * The WebSocket pool is then returned before the first socket opens, so
 * `connected` can settle on the caller's signal or timeout.
 */
export const neonEarly: unique symbol = Symbol();

/** The Neon `Pool` behind a WebSocket driver, so a startup bound can drop its sockets. */
export const neonPool: unique symbol = Symbol();

/**
 * HTTP startup hook. Called with `true` to abort fetches still in flight, and
 * with `false` once the check has finished.
 */
export const neonSettle: unique symbol = Symbol();

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
  return openWebSocket(config, true);
}

/**
 * Opens a replica pool without the connect-time WebSocket warm-up.
 *
 * A refused or unresolvable replica would reject `open` and abort the whole
 * topology. The pool stays, the first probe fails, and later probes connect
 * when the replica answers. A primary still uses {@link open}, which warms
 * and rejects. HTTP mode never warms.
 *
 * @param config - URL, mode, pool size, and acquire timeout
 * @returns The pool
 */
export function openReplica(config: NeonConfig): Promise<DriverPool> {
  if (config.mode === "http") return open(config);
  return openWebSocket(config, false);
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

async function openWebSocket(config: NeonConfig, warm: boolean): Promise<DriverPool> {
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
  const driver = Object.assign(
    {
      capabilities: NEON_WEBSOCKET_CAPABILITIES,
      execute(
        text: string,
        params: readonly WireValue[] | undefined,
        options: ExecuteOptions | undefined,
      ) {
        const refused = noTimeout(options);
        if (refused !== undefined) return refused;
        if (closed) return rejectAfterClose();
        const next = releasedSignal(options);
        if (next === null) return rejectCancelled();
        return runCall(closed, next, (watch) => root.query(text, params, watch));
      },
      async batch(statements: readonly Statement[], options: ExecuteOptions | undefined) {
        const refused = noTimeout(options);
        if (refused !== undefined) return refused;
        if (releasedSignal(options) === null) return rejectCancelled();
        const connection = await checkout();
        try {
          const next = releasedSignal(options);
          if (next === null) return rejectCancelled();
          return await connection.batch(statements, next);
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
    } satisfies DriverPool,
    { [neonPool]: pool },
  );
  // A replica stays a pool when its first socket fails. The probe connects later.
  if (!warm) return driver;
  const warming = take(pool).then((client) => {
    client.release();
  });
  // A bounded startup check has to return a client before this socket opens.
  if (neonEarly in config) {
    void warming.catch(() => undefined);
    return driver;
  }
  try {
    await warming;
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw await mapFailure(error);
  }
  return driver;
}

/**
 * Drops `signal` once an abort can no longer stop the statement.
 *
 * An abort that has already fired returns `null`: the caller rejects with
 * `cancelled` and sends nothing. A later abort is ignored. Neon cannot cancel
 * a statement it has sent. `timeout` is kept. This driver does not read `route`.
 *
 * @param options - Per-call options
 * @returns Options with no signal, the same object when there was none, or `null`
 */
export function releasedSignal(
  options: ExecuteOptions | undefined,
): ExecuteOptions | undefined | null {
  const signal = options?.signal;
  if (signal?.aborted === true) return null;
  if (signal === undefined) return options;
  const timeout = options?.timeout;
  return timeout === undefined ? undefined : { timeout };
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
