/**
 * node-postgres adapter (`okmodel/pg/pg`).
 *
 * One pool per `open` call. `pg` is an optional peer of this entry.
 * Idle clients are unref'd (`allowExitOnIdle`) and are not closed on a timer
 * (`idleTimeoutMillis: 0`), so a finished script exits and a live process
 * keeps its connection. Cancel sends a Postgres CancelRequest on a side
 * socket. That socket is unref'd.
 */

import net from "node:net";
import pg, { type PoolClient, type QueryConfig, type QueryResult } from "pg";

import type {
  DriverConnection,
  DriverPool,
  DriverPoolConfig,
  DriverStats,
  WireValue,
} from "../../contracts/driver.js";
import { NODE_POSTGRES_CAPABILITIES } from "../capabilities.js";
import {
  driverErrors,
  mapFailure,
  rejectCancelled,
  rejectClosed,
  rejectTimedOut,
} from "../failure.js";
import { runCall } from "./call.js";
import { noticeBuffer, WireSession, type WireQuery } from "./session.js";

export {
  hasCapability,
  NODE_POSTGRES_CAPABILITIES as capabilities,
  readCapability,
} from "../capabilities.js";
export { DriverError } from "../error.js";

/** Options for {@link open}. */
export type NodePostgresConfig = DriverPoolConfig & {
  /** Connection URL for this endpoint. */
  readonly url: string;
  /**
   * Named prepared statements, or the unnamed protocol.
   *
   * Unnamed is the default. It stays valid behind a pooler in transaction mode.
   * `prepared: "named"` is not for transaction-mode poolers.
   */
  readonly prepared?: "named" | "unnamed";
  /** Session search path for every connection in the pool. */
  readonly searchPath?: string;
  /** TLS mode passed to node-postgres. */
  readonly ssl?: boolean | "require" | "allow" | "prefer" | "verify-full" | object;
};

/** What a checkout needs from the pool that opened it. */
export type HeldPool = {
  readonly pool: InstanceType<typeof pg.Pool>;
  readonly acquireMs: number | undefined;
  readonly counters: Counters;
  readonly notices: ReturnType<typeof noticeBuffer>;
  readonly named: boolean;
  readonly isClosed: () => boolean;
};

/** Pool occupancy. */
export type Counters = {
  reserved: number;
  busy: number;
  reservedBusy: number;
  waiting: number;
};

const CANCEL_CODE = 80877102;

/**
 * After a call aborts, how long the query may still settle before the
 * checked-out client is destroyed.
 *
 * Cancel should finish as `57014` and return the connection. A backend that
 * is already gone never answers; leaving that client checked out pins a pool
 * slot until the socket times out.
 */
const ABORT_GRACE_MS = 250;

const identity = (value: string): string => value;

/**
 * Attaches the one error listener a pool or a checked-out client can use.
 *
 * node-postgres types list `connect` and `notification` only. An idle pool
 * client and a `LISTEN` client both emit `error` with no listener, and that
 * is an uncaught exception. The default handler ignores it. The pool has
 * already removed an idle client.
 *
 * @param source - Pool or client
 * @param handle - What to do with the error
 */
export function armDriverError(source: object, handle: (error?: unknown) => void = () => {}): void {
  (source as { on(event: "error", listener: (error: unknown) => void): void }).on("error", handle);
}

/**
 * Records an idle or checked-out client error on the notice path (B-44).
 *
 * Does not throw. The pool has already dropped a dead idle client.
 *
 * @param notices - Pool notice buffer
 * @param error - The `error` event value
 */
export function logClientError(
  notices: { push(notice: { severity: string; message: string; code?: string }): void },
  error: unknown,
): void {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "client error";
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? Reflect.get(error, "code")
      : undefined;
  notices.push({
    severity: "ERROR",
    message,
    ...(typeof code === "string" && code.length > 0 ? { code } : {}),
  });
}

/** Text values stay text. The dialect owns parsing. */
const WIRE = {
  getTypeParser(): (value: string) => string {
    return identity;
  },
};

/**
 * Opens a node-postgres pool for one endpoint.
 *
 * @param config - URL, pool size, and acquire timeout
 * @returns The pool
 */
export function open(config: NodePostgresConfig): DriverPool {
  const max = config.max ?? 10;
  // Default 10 s so a storm cannot leave reserve() unsettled (B-44 companion).
  const acquireMs = config.timeouts?.acquire ?? 1e4;
  const counters: Counters = { reserved: 0, busy: 0, reservedBusy: 0, waiting: 0 };
  const inflight = new Set<WireQuery>();
  const notices = noticeBuffer();
  let closed = false;
  const isClosed = (): boolean => closed;
  const named = config.prepared === "named";

  const pool = new pg.Pool({
    connectionString: config.url,
    max,
    idleTimeoutMillis: 0,
    allowExitOnIdle: true,
    connectionTimeoutMillis: 5_000,
    application_name: "okmodel",
    types: WIRE,
    ...(config.ssl !== undefined ? { ssl: config.ssl } : {}),
    ...(config.searchPath !== undefined ? { options: `-c search_path=${config.searchPath}` } : {}),
  });
  // The pool has already removed the idle client before this runs.
  armDriverError(pool, (error) => {
    logClientError(notices, error);
  });
  pool.on("connect", (client) => {
    client.on("notice", (notice) => {
      notices.push(notice);
    });
    // Stay on the client after checkout removes the pool idle listener (B-44).
    armDriverError(client, (error) => {
      logClientError(notices, error);
    });
  });

  const root = new WireSession(
    (text, params) => send(pool, text, params, named, undefined),
    notices,
    isClosed,
    true,
    () => {
      counters.busy += 1;
    },
    () => {
      counters.busy = Math.max(0, counters.busy - 1);
    },
    inflight,
  );

  const held: HeldPool = { pool, acquireMs, counters, notices, named, isClosed };
  const checkout = (): Promise<DriverConnection> =>
    closed ? rejectClosed() : import("./nodepostgres-extra.js").then((mod) => mod.checkout(held));

  return {
    capabilities: NODE_POSTGRES_CAPABILITIES,
    execute(text, params, options) {
      return runCall(closed, options, async (watch) => {
        if (watch === undefined) return root.query(text, params, undefined);
        const client = await connectClient(pool, acquireMs, counters);
        // The call timed out while it waited for a pool slot. Release the
        // client without a query so a backlog of aborted checkouts cannot
        // pin every connection.
        if (watch.signal.aborted) {
          client.release();
          return watch.reason() === "cancelled" ? rejectCancelled() : rejectTimedOut();
        }
        counters.busy += 1;
        // `connect` already logs client errors. This listener only marks the
        // checkout dead, and it is removed on release so timed calls cannot
        // stack `error` listeners on a reused client.
        const slot = trackCheckout(client, () => {
          counters.busy = Math.max(0, counters.busy - 1);
        });
        const session = new WireSession(
          (statement, values) => send(client, statement, values, named, client),
          notices,
          isClosed,
          true,
          () => undefined,
          () => undefined,
          inflight,
        );
        if (watch.signal.aborted) slot.abandon();
        else watch.signal.addEventListener("abort", slot.abandon, { once: true });
        try {
          return await session.query(text, params, watch);
        } finally {
          watch.signal.removeEventListener("abort", slot.abandon);
          slot.release();
        }
      });
    },
    async batch(statements, options) {
      const connection = await checkout();
      try {
        return await connection.batch(statements, options);
      } finally {
        await connection.release();
      }
    },
    reserve: () => checkout(),
    stream(text, params) {
      return (async function* () {
        const { streamRows } = await import("./nodepostgres-extra.js");
        yield* streamRows(checkout, text, params);
      })();
    },
    listen(channel, onNotify) {
      if (closed) return rejectClosed();
      return import("./nodepostgres-extra.js").then((mod) => mod.listen(held, channel, onNotify));
    },
    cancel() {
      for (const pending of inflight) pending.cancel?.();
    },
    stats: () => statsOf(counters, max),
    async close() {
      closed = true;
      await pool.end();
    },
  };
}

export function send(
  runner: { query(config: QueryConfig): Promise<QueryResult> },
  text: string,
  params: readonly WireValue[] | undefined,
  named: boolean,
  client: PoolClient | undefined,
): WireQuery {
  const query: QueryConfig = {
    text,
    rowMode: "array",
    types: WIRE,
    ...(params !== undefined && params.length > 0 ? { values: params } : {}),
    ...(named ? { name: statementName(text) } : {}),
  };
  const pending = runner.query(query) as WireQuery;
  if (client !== undefined) pending.cancel = () => cancelBackend(client);
  return pending;
}

const names = new Map<string, string>();

function statementName(text: string): string {
  const existing = names.get(text);
  if (existing !== undefined) return existing;
  const name = `okm_${String(names.size)}`;
  names.set(text, name);
  return name;
}

/**
 * Sends a CancelRequest on a new socket and drops it.
 *
 * The query connection stays up and receives `57014`. The side socket is
 * unref'd so it does not keep a finished script alive.
 *
 * @param client - The backend running the statement
 */
function cancelBackend(client: PoolClient): void {
  const pid = client.processID;
  const secret = client.secretKey;
  if (typeof pid !== "number" || typeof secret !== "number") return;
  const socket =
    client.host.startsWith("/") === true
      ? net.connect(client.host)
      : net.connect(client.port, client.host);
  socket.unref();
  socket.once("error", () => {
    socket.destroy();
  });
  socket.once("connect", () => {
    const bytes = Buffer.alloc(16);
    bytes.writeInt32BE(16, 0);
    bytes.writeInt32BE(CANCEL_CODE, 4);
    bytes.writeInt32BE(pid, 8);
    bytes.writeInt32BE(secret, 12);
    socket.end(bytes);
  });
}

/**
 * Tracks one checked-out client until the timed call finishes.
 *
 * A connection `error` destroys the client on release instead of returning it
 * to the pool. If the call aborts and the query does not settle, the client
 * is destroyed after {@link ABORT_GRACE_MS} so the slot cannot stay pinned.
 *
 * @param client - The checked-out client
 * @param done - Runs once, when the checkout is released
 * @returns Abandon on abort, and release when the call ends
 */
function trackCheckout(client: PoolClient, done: () => void): { abandon(): void; release(): void } {
  let dead = false;
  let released = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const onError = (): void => {
    dead = true;
  };
  const events = client as unknown as {
    on(event: "error", listener: () => void): void;
    removeListener(event: "error", listener: () => void): void;
  };
  events.on("error", onError);
  const release = (): void => {
    if (released) return;
    released = true;
    if (grace !== undefined) clearTimeout(grace);
    events.removeListener("error", onError);
    done();
    client.release(dead ? true : undefined);
  };
  return {
    abandon() {
      if (released || grace !== undefined) return;
      grace = setTimeout(() => {
        dead = true;
        release();
      }, ABORT_GRACE_MS);
      grace.unref();
    },
    release,
  };
}

export function connectClient(
  pool: InstanceType<typeof pg.Pool>,
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
    pool.connect().then(
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

function statsOf(counters: Counters, size: number): DriverStats {
  return {
    size,
    idle: Math.max(0, size - counters.reserved - counters.busy),
    inflight: counters.busy + counters.reservedBusy,
    waiting: counters.waiting,
  };
}
