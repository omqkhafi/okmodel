/**
 * postgres.js adapter (`okmodel/pg/postgresjs`).
 *
 * One pool per `open` call. Plain `execute` uses the driver's pool directly,
 * so it does not take an extra checkout. `reserve` checks out one connection
 * and clears session state on release. `postgres` is a peer of this entry.
 */

import postgres, { type Sql } from "postgres";

import type {
  DescribeResult,
  DriverConnection,
  DriverPool,
  DriverPoolConfig,
  DriverStats,
  ExecuteResult,
  Notice,
  WireValue,
} from "../../contracts/driver.js";
import { POSTGRESJS_CAPABILITIES } from "../capabilities.js";
import {
  acquireTimeout,
  cancelled,
  DriverError,
  errorField,
  mapDriverError,
  timedOut,
} from "../error.js";
import { type BatchSession, nextTransactionDepth, runAtomicBatch } from "./batch.js";
import { runCall, type Watch } from "./call.js";
import { EMPTY_NOTICES, resultFrom, rowsFrom } from "./result.js";

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
};

type Canceller = {
  cancel(): void;
};

type Pending = Canceller & Promise<unknown>;

type Counters = {
  reserved: number;
  busy: number;
  reservedBusy: number;
  waiting: number;
};

type NoticeBuffer = {
  start(): number;
  since(start: number): readonly Notice[];
};

const RESET_ALL = "RESET ALL";
const UNLOCK = "SELECT pg_advisory_unlock_all()";

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

  const sql = postgres(config.url, {
    max,
    prepare: true,
    idle_timeout: 30,
    connect_timeout: 5,
    types: WIRE_TYPES,
    connection: { application_name: "okmodel" },
    onnotice(notice) {
      notices.push(notice);
    },
  });

  const root = new PgSession(sql, counters, "pool", poolInflight, isClosed, undefined, notices);

  async function checkout(): Promise<DriverConnection> {
    if (closed) throw new DriverError("The pool is closed.");
    const reserved = await reserveConnection(sql, acquireMs, counters);
    counters.reserved += 1;
    const local = new Set<Canceller>();
    const session = new PgSession(
      reserved,
      counters,
      "reserved",
      local,
      isClosed,
      poolInflight,
      notices,
    );
    let released = false;
    return {
      execute: (text, params, options) =>
        runCall(closed, options, (watch) => session.query(text, params, watch)),
      batch: (statements, options) =>
        runCall(closed, options, (watch) => runAtomicBatch(session, statements, watch)),
      cancel() {
        session.cancel();
      },
      async release() {
        if (released) return;
        released = true;
        try {
          await resetConnection(reserved, session.depth());
        } finally {
          counters.reserved = Math.max(0, counters.reserved - 1);
          reserved.release();
        }
      },
    };
  }

  return {
    capabilities: POSTGRESJS_CAPABILITIES,
    execute(text, params, options) {
      return runCall(closed, options, (watch) => root.query(text, params, watch));
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
    describe: (text, params) => root.describe(text, params),
    stream: (text, params) => root.stream(text, params),
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

class PgSession implements BatchSession {
  readonly canCancel = true;
  private transactionDepth = 0;
  private readonly sql: Sql;
  private readonly counters: Counters;
  private readonly scope: "pool" | "reserved";
  private readonly local: Set<Canceller>;
  private readonly isClosed: () => boolean;
  private readonly shared: Set<Canceller> | undefined;
  private readonly notices: NoticeBuffer;

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
  ) {
    this.sql = sql;
    this.counters = counters;
    this.scope = scope;
    this.local = local;
    this.isClosed = isClosed;
    this.shared = shared;
    this.notices = notices;
  }

  /** @inheritdoc */
  query(
    text: string,
    params: readonly WireValue[] | undefined,
    watch: Watch | undefined,
  ): Promise<ExecuteResult> {
    if (this.isClosed()) return Promise.reject(new DriverError("The pool is closed."));
    const start = this.notices.start();
    this.enter();
    const pending = send(this.sql, text, params);
    if (watch === undefined) {
      return pending.then(
        (result) => {
          this.leave();
          this.note(text);
          return resultFrom(result, this.notices.since(start));
        },
        (error: unknown) => {
          this.leave();
          throw mapDriverError(error);
        },
      );
    }
    return this.watched(pending, watch, start, text);
  }

  /**
   * Describes a statement.
   *
   * @param text - SQL
   * @param params - Wire parameters
   * @returns Column names and the parameter count
   */
  async describe(text: string, params?: readonly WireValue[]): Promise<DescribeResult> {
    const pending = this.sql.unsafe(text, asParams(params), { prepare: true });
    const described = await pending.describe();
    return {
      columns: described.columns.map((column) => column.name),
      parameterCount: described.types.length,
    };
  }

  /**
   * Yields cursor chunks.
   *
   * @param text - SQL
   * @param params - Wire parameters
   * @returns Chunks of wire rows
   */
  async *stream(
    text: string,
    params?: readonly WireValue[],
  ): AsyncIterable<readonly (readonly WireValue[])[]> {
    const pending = this.sql.unsafe(text, asParams(params));
    for await (const chunk of pending.cursor(64)) {
      yield rowsFrom(chunk);
    }
  }

  /** @inheritdoc */
  begin(watch: Watch | undefined): Promise<void> {
    return this.control("BEGIN", watch);
  }

  /** @inheritdoc */
  commit(watch: Watch | undefined): Promise<void> {
    return this.control("COMMIT", watch);
  }

  /** @inheritdoc */
  rollback(): Promise<void> {
    return this.sql.unsafe("ROLLBACK").then(
      () => {
        this.transactionDepth = 0;
      },
      (error: unknown) => {
        this.transactionDepth = 0;
        throw mapDriverError(error);
      },
    );
  }

  /** @inheritdoc */
  savepoint(name: string): Promise<void> {
    return this.sql.unsafe(`SAVEPOINT ${name}`).then(() => undefined);
  }

  /** @inheritdoc */
  releaseSavepoint(name: string): Promise<void> {
    return this.sql.unsafe(`RELEASE SAVEPOINT ${name}`).then(() => undefined);
  }

  /** @inheritdoc */
  rollbackTo(name: string): Promise<void> {
    return this.sql.unsafe(`ROLLBACK TO SAVEPOINT ${name}`).then(() => undefined);
  }

  /** @inheritdoc */
  inTransaction(): boolean {
    return this.transactionDepth > 0;
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

  private control(text: "BEGIN" | "COMMIT", watch: Watch | undefined): Promise<void> {
    return this.query(text, undefined, watch).then(() => undefined);
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
        if (why === "timeout") throw timedOut();
        if (why === "cancelled") throw cancelled();
        this.note(text);
        return resultFrom(result, this.notices.since(start));
      },
      (error: unknown) => {
        this.finishWatched(pending, watch, onAbort);
        throw classify(error, watch);
      },
    );
  }

  private finishWatched(pending: Canceller, watch: Watch, onAbort: () => void): void {
    this.leave();
    this.untrack(pending);
    watch.signal.removeEventListener("abort", onAbort);
  }
}

function send(sql: Sql, text: string, params: readonly WireValue[] | undefined): Pending {
  if (params === undefined || params.length === 0) return sql.unsafe(text).raw();
  return sql.unsafe(text, asParams(params)).raw();
}

function asParams(params: readonly WireValue[] | undefined): string[] {
  if (params === undefined) return [];
  return params as unknown as string[];
}

function classify(error: unknown, watch: Watch): unknown {
  if (error instanceof DriverError) return error;
  const why = watch.reason();
  if (why === "timeout") return timedOut(error);
  if (why === "cancelled" || errorField(error, "code") === "57014") return cancelled(error);
  return mapDriverError(error);
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

type ReservedConnection = Sql & {
  release(): void;
};

function reserveConnection(
  sql: Sql,
  acquireMs: number | undefined,
  counters: Counters,
): Promise<ReservedConnection> {
  counters.waiting += 1;
  let settled = false;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (acquireMs !== undefined) {
      timer = setTimeout(() => {
        settled = true;
        counters.waiting = Math.max(0, counters.waiting - 1);
        reject(acquireTimeout());
      }, acquireMs);
    }
    sql.reserve().then(
      (connection) => {
        if (settled) {
          void resetConnection(connection, 0).finally(() => {
            connection.release();
          });
          return;
        }
        if (timer !== undefined) clearTimeout(timer);
        counters.waiting = Math.max(0, counters.waiting - 1);
        resolve(connection);
      },
      (error: unknown) => {
        if (settled) return;
        if (timer !== undefined) clearTimeout(timer);
        counters.waiting = Math.max(0, counters.waiting - 1);
        reject(mapDriverError(error));
      },
    );
  });
}

async function resetConnection(sql: Sql, depth: number): Promise<void> {
  if (depth > 0) await sql.unsafe("ROLLBACK").catch(() => undefined);
  try {
    await sql.unsafe(RESET_ALL);
    await sql.unsafe(UNLOCK);
  } catch {
    await sql.unsafe("ROLLBACK").catch(() => undefined);
    await sql.unsafe(RESET_ALL);
    await sql.unsafe(UNLOCK);
  }
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
