/**
 * postgres.js adapter (`okmodel/pg/postgresjs`).
 *
 * One pool per `open` call. Plain `execute` uses the driver's pool directly,
 * so it does not take an extra checkout. `reserve` checks out one connection
 * and clears session state on release. `postgres` is a peer of this entry.
 */

import net from "node:net";
import postgres, { type Sql } from "postgres";

import type {
  DriverPool,
  DriverPoolConfig,
  DriverStats,
  ExecuteResult,
  Notice,
  WireValue,
} from "../../contracts/driver.js";
import { POSTGRESJS_CAPABILITIES } from "../capabilities.js";
import { mapFailure, rejectClosed } from "../failure.js";
import type { BatchSession } from "./batch.js";
import { nextTransactionDepth, runCall, type Watch } from "./call.js";
import { EMPTY_NOTICES, resultFrom } from "./result.js";

export {
  POSTGRESJS_CAPABILITIES as capabilities,
  hasCapability,
  readCapability,
} from "../capabilities.js";
export { DriverError } from "../error.js";

/** Options for {@link open}. */
export type PostgresJsConfig = DriverPoolConfig & {
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
  /** TLS mode passed to postgres.js. */
  readonly ssl?: boolean | "require" | "allow" | "prefer" | "verify-full" | object;
};

/** Something an in-flight query can abort. */
export type Canceller = {
  cancel(): void;
};

type Pending = Canceller & Promise<unknown>;

/** Pool occupancy. Shared by execute and by a reserved connection. */
export type Counters = {
  reserved: number;
  busy: number;
  reservedBusy: number;
  waiting: number;
};

/** Notice slice shared by the pool. */
export type NoticeBuffer = {
  start(): number;
  since(start: number): readonly Notice[];
};

/** Fields the socket factory reads off the parsed postgres.js options. */
type SocketTarget = {
  readonly host: readonly string[];
  readonly port: readonly number[];
  readonly path?: string | false;
};

/**
 * Sockets this pool opened.
 *
 * A new socket is referenced, which keeps a finished script alive. The pool
 * unrefs them while nothing is in flight and refs them again for the next
 * call. A process that stays up for its own work keeps the connection.
 */
class PoolSockets {
  private readonly held: net.Socket[] = [];
  private busy = 0;
  private listeners = 0;
  private hostCursor = 0;

  /**
   * Opens one socket and remembers it.
   *
   * @param target - Host, port, and optional unix path from postgres.js
   * @returns The socket postgres.js should use
   */
  connect(target: SocketTarget): net.Socket {
    const path = typeof target.path === "string" ? target.path : undefined;
    const hosts = target.host;
    const ports = target.port;
    const index = hosts.length === 0 ? 0 : this.hostCursor % hosts.length;
    this.hostCursor += 1;
    const host = hosts[index] ?? "localhost";
    const port = ports[index] ?? ports[0] ?? 5432;
    const socket = path !== undefined ? net.connect(path) : net.connect(port, host);
    this.held.push(socket);
    return socket;
  }

  /**
   * Refs sockets for one call and unrefs them when it finishes.
   *
   * @param run - The call
   * @returns The call's result
   */
  occupy<T>(run: () => Promise<T>): Promise<T> {
    this.busy += 1;
    this.wake();
    return run().finally(() => {
      this.busy -= 1;
      this.park();
    });
  }

  /** Refcount for one execute/checkout/stream (`busy`) or `LISTEN` (`listeners`). */
  gate(key: "busy" | "listeners"): { enter(): void; leave(): void } {
    return {
      enter: () => {
        this[key] += 1;
        this.wake();
      },
      leave: () => {
        this[key] -= 1;
        this.park();
      },
    };
  }

  private wake(): void {
    for (const s of this.held) if (s.writable) s.ref();
  }

  private park(): void {
    if (this.busy > 0 || this.listeners > 0) return;
    for (const s of this.held) if (s.writable) s.unref();
  }
}

function driverOptions(
  config: PostgresJsConfig,
  state: {
    readonly max: number;
    readonly named: boolean;
    readonly plain: boolean;
    readonly notices: { push(notice: postgres.Notice): void };
    readonly sockets: PoolSockets;
  },
) {
  return {
    max: state.max,
    prepare: state.named,
    idle_timeout: state.plain ? 0 : 30,
    ...(state.plain ? { max_lifetime: null } : {}),
    connect_timeout: 5,
    backoff: () => 0.05 + Math.random() * 0.2,
    types: WIRE_TYPES,
    ...(state.plain ? { socket: (options: SocketTarget) => state.sockets.connect(options) } : {}),
    ...(config.ssl !== undefined ? { ssl: config.ssl } : {}),
    connection: {
      application_name: "okmodel",
      ...(config.searchPath !== undefined ? { search_path: config.searchPath } : {}),
    },
    onnotice(notice: postgres.Notice) {
      state.notices.push(notice);
    },
  };
}

/** Open pools rebuilt after a null-socket `nextWrite` (B-02). */
type Live = { on: boolean; sql: Sql; m(): Sql };

const lives: Live[] = [];

// D241 / D294 / B-02: postgres.js nextWrite on a null socket is upstream
// (docs/postgresjs-kill-storm.md). This listener is damage control only: it
// rebuilds stuck pools so the next read is not dead-queued. It does not stop
// the exception from firing. Prefer pg or Bun.sql where kill storms are
// expected. Bun exits 0 when a listener returns; print + exitCode so CLI
// refusals keep stderr and fail. A closed stderr (EPIPE from `okm … 2>&1 |
// head`) must not be printed: that write is another EPIPE and Node never
// leaves the handler.
process.on("uncaughtException", (e: unknown) => {
  if (closedPipe(e)) {
    process.exit(typeof process.exitCode === "number" ? process.exitCode : 1);
  }
  if (e instanceof TypeError && /socket\.write|reading 'write'/.test(e.message)) {
    for (const x of lives) {
      if (!x.on) continue;
      const prev = x.sql;
      x.m();
      void prev.end({ timeout: 0 }).catch(() => {});
    }
    return;
  }
  console.error(e);
  process.exitCode = 1;
});

function closedPipe(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED";
}

/**
 * Opens a postgres.js pool for one endpoint.
 *
 * @param config - URL, pool size, and acquire timeout
 * @returns The pool
 */
export function open(config: PostgresJsConfig): DriverPool {
  const max = config.max ?? 10;
  const acquireMs = config.timeouts?.acquire ?? 1e4;
  const counters: Counters = { reserved: 0, busy: 0, reservedBusy: 0, waiting: 0 };
  const poolInflight = new Set<Canceller>();
  const notices = noticeBuffer();
  let closed = false;
  const isClosed = (): boolean => closed;

  const named = config.prepared === "named";
  // postgres.js keeps a referenced idle timer and a lifetime timer. Neither
  // object is reachable, so they cannot be unref'd. A plain pool therefore
  // starts neither, and unrefs its sockets while idle. `ssl` still uses the
  // driver's socket, so that pool keeps the 30s idle timer and can exit.
  const plain = config.ssl === undefined;
  const sockets = new PoolSockets();
  const opts = { max, named, plain, notices, sockets };
  const make = (): Sql => postgres(config.url, driverOptions(config, opts));
  const root = new PgSession(
    make(),
    counters,
    "pool",
    poolInflight,
    isClosed,
    undefined,
    notices,
    named,
  );
  const held = {
    on: true,
    m: (): Sql => (root.sql = make()),
    get sql() {
      return root.sql;
    },
    acquireMs,
    counters,
    isClosed,
    notices,
    named,
    poolInflight,
  };
  lives.push(held);

  return {
    capabilities: POSTGRESJS_CAPABILITIES,
    execute(text, params, options) {
      return sockets.occupy(() =>
        runCall(closed, options, (watch) => root.query(text, params, watch)),
      );
    },
    batch(statements, options) {
      return sockets.occupy(() =>
        import("./postgres-extra.js").then((mod) => mod.runBatch(held, statements, options)),
      );
    },
    reserve() {
      const gate = sockets.gate("busy");
      gate.enter();
      return import("./postgres-extra.js").then(
        (mod) => mod.holdCheckout(gate, () => mod.checkout(held)),
        (error: unknown) => {
          gate.leave();
          throw error;
        },
      );
    },
    describe: (text, params) =>
      sockets.occupy(() =>
        import("./postgres-extra.js").then((mod) => mod.describe(root.sql, text, params)),
      ),
    stream(text, params) {
      const gate = sockets.gate("busy");
      return (async function* () {
        gate.enter();
        try {
          yield* (await import("./postgres-extra.js")).stream(root.sql, text, params);
        } finally {
          gate.leave();
        }
      })();
    },
    listen(channel, onNotify) {
      const gate = sockets.gate("listeners");
      gate.enter();
      return import("./postgres-extra.js").then(
        (mod) =>
          mod.holdListener(gate, async () => {
            const listening = await root.sql.listen(channel, onNotify);
            return async () => {
              await listening.unlisten();
            };
          }),
        (error: unknown) => {
          gate.leave();
          throw error;
        },
      );
    },
    cancel() {
      for (const pending of poolInflight) pending.cancel();
    },
    stats: () => statsOf(counters, max),
    async close() {
      closed = true;
      held.on = false;
      await root.sql.end({ timeout: 5 });
    },
  };
}

export class PgSession implements BatchSession {
  readonly canCancel = true;
  private transactionDepth = 0;
  /** Current client. A storm rebuild assigns a new pool client here. */
  sql: Sql;
  private readonly counters: Counters;
  private readonly scope: "pool" | "reserved";
  private readonly local: Set<Canceller>;
  private readonly isClosed: () => boolean;
  private readonly shared: Set<Canceller> | undefined;
  private readonly notices: NoticeBuffer;
  private readonly named: boolean;

  /**
   * @param sql - Root client or a reserved connection
   * @param counters - Pool counters
   * @param scope - Pool executes are not checkouts
   * @param local - In-flight queries this connection cancels
   * @param isClosed - Pool closed flag
   * @param shared - Pool-wide in-flight set for a reserved connection
   * @param notices - Notice buffer shared by the pool
   */
  constructor(
    sql: Sql,
    counters: Counters,
    scope: "pool" | "reserved",
    local: Set<Canceller>,
    isClosed: () => boolean,
    shared: Set<Canceller> | undefined,
    notices: NoticeBuffer,
    named: boolean,
  ) {
    this.sql = sql;
    this.counters = counters;
    this.scope = scope;
    this.local = local;
    this.isClosed = isClosed;
    this.shared = shared;
    this.notices = notices;
    this.named = named;
  }

  /** @inheritdoc */
  query(
    text: string,
    params: readonly WireValue[] | undefined,
    watch: Watch | undefined,
  ): Promise<ExecuteResult> {
    if (this.isClosed()) return rejectClosed();
    const start = this.notices.start();
    this.enter();
    const pending = send(this.sql, text, params, this.named);
    if (watch === undefined) {
      return pending.then(
        (result) => {
          this.leave();
          this.note(text);
          return resultFrom(result, this.notices.since(start));
        },
        (error: unknown) => {
          this.leave();
          return mapFailure(error).then((mapped) => {
            throw mapped;
          });
        },
      );
    }
    this.local.add(pending);
    this.shared?.add(pending);
    const onAbort = (): void => {
      pending.cancel();
    };
    if (watch.signal.aborted) onAbort();
    else watch.signal.addEventListener("abort", onAbort, { once: true });
    return import("./postgres-extra.js").then(
      (mod) =>
        mod.watchQuery(pending, watch, onAbort, {
          start,
          text,
          notices: this.notices,
          leave: () => {
            this.leave();
          },
          note: (sqlText) => {
            this.note(sqlText);
          },
          untrack: (item) => {
            this.local.delete(item);
            this.shared?.delete(item);
          },
        }),
      (error: unknown) => {
        this.leave();
        this.local.delete(pending);
        this.shared?.delete(pending);
        watch.signal.removeEventListener("abort", onAbort);
        throw error;
      },
    );
  }

  /** @inheritdoc */
  inTransaction(): boolean {
    return this.transactionDepth > 0;
  }

  /** @inheritdoc */
  abandon(): void {
    this.transactionDepth = 0;
  }

  /**
   * Open transaction depth.
   *
   * @returns The depth. Zero means no transaction
   */
  depth(): number {
    return this.transactionDepth;
  }

  /** Aborts in-flight statements on this connection. */
  cancel(): void {
    for (const pending of this.local) pending.cancel();
  }

  private note(text: string): void {
    this.transactionDepth = nextTransactionDepth(this.transactionDepth, text);
  }

  private enter(): void {
    this.counters[this.scope === "pool" ? "busy" : "reservedBusy"] += 1;
  }

  private leave(): void {
    const k = this.scope === "pool" ? "busy" : "reservedBusy";
    this.counters[k] = Math.max(0, this.counters[k] - 1);
  }
}

function send(
  sql: Sql,
  text: string,
  params: readonly WireValue[] | undefined,
  named: boolean,
): Pending {
  return !named && (params === undefined || params.length === 0)
    ? sql.unsafe(text).raw()
    : sql.unsafe(text, asParams(params), { prepare: named }).raw();
}

const asParams = (params?: readonly WireValue[]): string[] => (params ?? []) as unknown as string[];

const statsOf = (c: Counters, size: number): DriverStats => ({
  size,
  idle: Math.max(0, size - c.reserved - c.busy),
  inflight: c.busy + c.reservedBusy,
  waiting: c.waiting,
});

function noticeBuffer(): NoticeBuffer & { push(notice: postgres.Notice): void } {
  let notices: Notice[] | undefined;
  return {
    push(notice) {
      const severity = typeof notice.severity === "string" ? notice.severity : "";
      const message = typeof notice.message === "string" ? notice.message : "";
      const code = typeof notice.code === "string" && notice.code ? notice.code : undefined;
      (notices ??= []).push(code ? { severity, message, code } : { severity, message });
    },
    start: () => notices?.length ?? 0,
    since: (start) =>
      notices === undefined || notices.length === start ? EMPTY_NOTICES : notices.slice(start),
  };
}

function wire(to: number, from: number[]) {
  return { to, from, serialize: String, parse: String };
}

/**
 * Identity codecs. postgres.js rewrites wire text: boolean `"t"` is sent as
 * `f`, JSON is parsed, and dates become `Date`. Callers pass wire text.
 */
const WIRE_TYPES = {
  number: wire(0, [21, 23, 26, 700, 701]),
  boolean: wire(16, [16]),
  bytea: wire(17, [17]),
  json: wire(114, [114, 3802]),
  date: wire(1184, [1082, 1114, 1184]),
  boolArray: wire(1000, [1000]),
  int2Array: wire(1005, [1005]),
  int4Array: wire(1007, [1007]),
  textArray: wire(1009, [1009]),
  int8Array: wire(1016, [1016]),
  numericArray: wire(1231, [1231]),
  jsonbArray: wire(3807, [3807]),
};
