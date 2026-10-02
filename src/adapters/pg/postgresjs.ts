/**
 * postgres.js adapter (`okmodel/pg/postgresjs`).
 *
 * One pool per `open` call. Plain `execute` uses the driver's pool directly,
 * so it does not take an extra checkout. `reserve` checks out one connection
 * and clears session state on release. `postgres` is a peer of this entry.
 */

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
import { driverErrors, mapFailure, rejectClosed } from "../failure.js";
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

/**
 * Opens a postgres.js pool for one endpoint.
 *
 * @param config - URL, pool size, and acquire timeout
 * @returns The pool
 */
export function open(config: PostgresJsConfig): DriverPool {
  const max = config.max ?? 10;
  const acquireMs = config.timeouts?.acquire;
  const counters: Counters = { reserved: 0, busy: 0, reservedBusy: 0, waiting: 0 };
  const poolInflight = new Set<Canceller>();
  const notices = noticeBuffer();
  let closed = false;
  const isClosed = (): boolean => closed;

  const named = config.prepared === "named";
  const sql = postgres(config.url, {
    max,
    prepare: named,
    idle_timeout: 30,
    connect_timeout: 5,
    types: WIRE_TYPES,
    ...(config.ssl !== undefined ? { ssl: config.ssl } : {}),
    connection: {
      application_name: "okmodel",
      ...(config.searchPath !== undefined ? { search_path: config.searchPath } : {}),
    },
    onnotice(notice) {
      notices.push(notice);
    },
  });

  const root = new PgSession(
    sql,
    counters,
    "pool",
    poolInflight,
    isClosed,
    undefined,
    notices,
    named,
  );
  const held = { sql, acquireMs, counters, isClosed, notices, named, poolInflight };

  return {
    capabilities: POSTGRESJS_CAPABILITIES,
    execute(text, params, options) {
      return runCall(closed, options, (watch) => root.query(text, params, watch));
    },
    async batch(statements, options) {
      const { checkout } = await import("./postgres-extra.js");
      const connection = await checkout(held);
      try {
        return await connection.batch(statements, options);
      } finally {
        await connection.release();
      }
    },
    reserve: () => import("./postgres-extra.js").then((mod) => mod.checkout(held)),
    describe: (text, params) =>
      import("./postgres-extra.js").then((mod) => mod.describe(sql, text, params)),
    stream(text, params) {
      return loadStream(sql, text, params);
    },
    async listen(channel, onNotify) {
      const listening = await sql.listen(channel, onNotify);
      return async () => {
        await listening.unlisten();
      };
    },
    cancel() {
      for (const pending of poolInflight) pending.cancel();
    },
    stats: () => statsOf(counters, max),
    async close() {
      closed = true;
      await sql.end({ timeout: 5 });
    },
  };
}

export class PgSession implements BatchSession {
  readonly canCancel = true;
  private transactionDepth = 0;
  private readonly sql: Sql;
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
    return this.watched(pending, watch, start, text);
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
    if (this.scope === "pool") this.counters.busy += 1;
    else this.counters.reservedBusy += 1;
  }

  private leave(): void {
    if (this.scope === "pool") this.counters.busy = Math.max(0, this.counters.busy - 1);
    else this.counters.reservedBusy = Math.max(0, this.counters.reservedBusy - 1);
  }

  private track(pending: Canceller): void {
    this.local.add(pending);
    this.shared?.add(pending);
  }

  private untrack(pending: Canceller): void {
    this.local.delete(pending);
    this.shared?.delete(pending);
  }

  private watched(
    pending: Pending,
    watch: Watch,
    start: number,
    text: string,
  ): Promise<ExecuteResult> {
    this.track(pending);
    const onAbort = (): void => {
      pending.cancel();
    };
    if (watch.signal.aborted) onAbort();
    else watch.signal.addEventListener("abort", onAbort, { once: true });
    return pending.then(
      (result) => {
        this.finishWatched(pending, watch, onAbort);
        const why = watch.reason();
        if (why === "timeout" || why === "cancelled") return classify(why, watch);
        this.note(text);
        return resultFrom(result, this.notices.since(start));
      },
      (error: unknown) => {
        this.finishWatched(pending, watch, onAbort);
        return classify(error, watch);
      },
    );
  }

  private finishWatched(pending: Canceller, watch: Watch, onAbort: () => void): void {
    this.leave();
    this.untrack(pending);
    watch.signal.removeEventListener("abort", onAbort);
  }
}

async function* loadStream(
  sql: Sql,
  text: string,
  params: readonly WireValue[] | undefined,
): AsyncIterable<readonly (readonly WireValue[])[]> {
  const { stream } = await import("./postgres-extra.js");
  yield* stream(sql, text, params);
}

function send(
  sql: Sql,
  text: string,
  params: readonly WireValue[] | undefined,
  named: boolean,
): Pending {
  if (!named && (params === undefined || params.length === 0)) return sql.unsafe(text).raw();
  return sql.unsafe(text, asParams(params), { prepare: named }).raw();
}

function asParams(params: readonly WireValue[] | undefined): string[] {
  if (params === undefined) return [];
  return params as unknown as string[];
}

async function classify(error: unknown, watch: Watch): Promise<never> {
  const errors = await driverErrors();
  if (error instanceof errors.DriverError) return Promise.reject(error);
  const why = typeof error === "string" ? error : watch.reason();
  if (why === "timeout")
    return Promise.reject(errors.timedOut(typeof error === "string" ? undefined : error));
  const code = errors.errorField(error, "code");
  if (why === "cancelled" || code === "57014") {
    return Promise.reject(errors.cancelled(typeof error === "string" ? undefined : error));
  }
  return Promise.reject(errors.mapDriverError(error));
}

function statsOf(counters: Counters, size: number): DriverStats {
  return {
    size,
    idle: Math.max(0, size - counters.reserved - counters.busy),
    inflight: counters.busy + counters.reservedBusy,
    waiting: counters.waiting,
  };
}

function noticeBuffer(): NoticeBuffer & { push(notice: postgres.Notice): void } {
  let notices: Notice[] | undefined;
  return {
    push(notice) {
      const severity = typeof notice.severity === "string" ? notice.severity : "";
      const message = typeof notice.message === "string" ? notice.message : "";
      const code =
        typeof notice.code === "string" && notice.code.length > 0 ? notice.code : undefined;
      const entry: Notice =
        code === undefined ? { severity, message } : { severity, message, code };
      (notices ??= []).push(entry);
    },
    start() {
      return notices?.length ?? 0;
    },
    since(start) {
      if (notices === undefined || notices.length === start) return EMPTY_NOTICES;
      return notices.slice(start);
    },
  };
}

function wire(to: number, from: readonly number[]) {
  return {
    to,
    from: [...from],
    serialize: (value: string) => value,
    parse: (value: string) => value,
  };
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
