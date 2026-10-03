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
import { driverErrors, mapFailure, rejectClosed } from "../failure.js";
import { runCall, type Watch } from "./call.js";
import { cursorStream, noticeBuffer, quoteIdent, WireSession, type WireQuery } from "./session.js";

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

/** Pool occupancy. */
type Counters = {
  reserved: number;
  busy: number;
  reservedBusy: number;
  waiting: number;
};

const CANCEL_CODE = 80877102;
const RESET_ALL = "RESET ALL";
const UNLOCK = "SELECT pg_advisory_unlock_all()";

const identity = (value: string): string => value;

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
  const acquireMs = config.timeouts?.acquire;
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
  pool.on("connect", (client) => {
    client.on("notice", (notice) => {
      notices.push(notice);
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

  return {
    capabilities: NODE_POSTGRES_CAPABILITIES,
    execute(text, params, options) {
      return runCall(closed, options, async (watch) => {
        if (watch === undefined) return root.query(text, params, undefined);
        const client = await connectClient(pool, acquireMs, counters);
        counters.busy += 1;
        const session = new WireSession(
          (statement, values) => send(client, statement, values, named, client),
          notices,
          isClosed,
          true,
          () => undefined,
          () => undefined,
          inflight,
        );
        try {
          return await session.query(text, params, watch);
        } finally {
          counters.busy = Math.max(0, counters.busy - 1);
          client.release();
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
      return stream(text, params);
    },
    listen(channel, onNotify) {
      return listen(channel, onNotify);
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

  async function checkout(): Promise<DriverConnection> {
    if (closed) return rejectClosed();
    const client = await connectClient(pool, acquireMs, counters);
    counters.reserved += 1;
    const local = new Set<WireQuery>();
    const session = new WireSession(
      (text, params) => send(client, text, params, named, client),
      notices,
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
    let released = false;
    return {
      execute: (text, params, options) =>
        runCall(closed, options, (watch) => session.query(text, params, watch)),
      batch: (statements, options) =>
        runCall(closed, options, async (watch: Watch | undefined) => {
          const { runAtomicBatch } = await import("./batch.js");
          return runAtomicBatch(session, statements, watch);
        }),
      cancel() {
        session.cancel();
      },
      async release() {
        if (released) return;
        released = true;
        try {
          await reset(session, client);
        } finally {
          counters.reserved = Math.max(0, counters.reserved - 1);
          client.release();
        }
      },
    };
  }

  function stream(
    text: string,
    params?: readonly WireValue[],
  ): AsyncIterable<readonly (readonly WireValue[])[]> {
    return (async function* () {
      const connection = await checkout();
      try {
        yield* cursorStream(
          (statement, values) => connection.execute(statement, values),
          text,
          params,
        );
      } finally {
        await connection.release();
      }
    })();
  }

  async function listen(
    channel: string,
    onNotify: (payload: string) => void,
  ): Promise<() => Promise<void>> {
    if (closed) return rejectClosed();
    const client = await connectClient(pool, acquireMs, counters);
    counters.reserved += 1;
    const quoted = quoteIdent(channel);
    const onNotification = (message: { channel: string; payload?: string }): void => {
      if (message.channel === channel) onNotify(message.payload ?? "");
    };
    client.on("notification", onNotification);
    try {
      await client.query(`LISTEN ${quoted}`);
    } catch (error) {
      counters.reserved = Math.max(0, counters.reserved - 1);
      client.release();
      throw error;
    }
    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      try {
        await client.query(`UNLISTEN ${quoted}`);
      } finally {
        client.removeListener("notification", onNotification);
        counters.reserved = Math.max(0, counters.reserved - 1);
        client.release();
      }
    };
  }
}

function send(
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

function connectClient(
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

function statsOf(counters: Counters, size: number): DriverStats {
  return {
    size,
    idle: Math.max(0, size - counters.reserved - counters.busy),
    inflight: counters.busy + counters.reservedBusy,
    waiting: counters.waiting,
  };
}
