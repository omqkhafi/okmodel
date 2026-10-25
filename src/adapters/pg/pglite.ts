/**
 * PGlite adapter (`okmodel/pg/pglite`).
 *
 * One database is a pool of one. `cancel` is false: a statement already
 * running cannot be aborted. `@electric-sql/pglite` is a peer of this entry.
 */

import type { PGlite, QueryOptions } from "@electric-sql/pglite";

import type {
  DescribeField,
  DescribeResult,
  DriverConnection,
  DriverPool,
  DriverPoolConfig,
  DriverStats,
  ExecuteResult,
  Notice,
  WireValue,
} from "../../contracts/driver.js";
import { PGLITE_CAPABILITIES } from "../capabilities.js";
import { driverErrors, rejectCancelled, rejectClosed, rejectTimedOut } from "../failure.js";
import type { BatchSession } from "./batch.js";
import { nextTransactionDepth, runCall, type Watch } from "./call.js";
import { noTimeout } from "./no-inflight-timeout.js";
import { EMPTY_NOTICES, resultFrom } from "./result.js";

export {
  hasCapability,
  PGLITE_CAPABILITIES as capabilities,
  readCapability,
} from "../capabilities.js";
export { DriverError } from "../error.js";

/** Options for {@link open}. The pool size is always one. */
export type PgliteConfig = DriverPoolConfig & {
  /** Data directory. `memory://` when omitted. */
  readonly dataDir?: string;
};

/**
 * Opens a PGlite pool of one.
 *
 * @param config - Data directory and acquire timeout. `max` is ignored
 * @returns The pool
 */
export async function open(config: PgliteConfig = {}): Promise<DriverPool> {
  const acquireMs = config.timeouts?.acquire;
  const slot = new Slot();
  const notices = noticeBuffer();
  let closed = false;
  let inflight = 0;
  let starting: Promise<Started> | undefined;
  let extensionNames: readonly string[] = [];

  function prepareExtensions(names: readonly string[]): Promise<void> {
    if (starting !== undefined) return Promise.resolve();
    extensionNames = names;
    return Promise.resolve();
  }

  function boot(): Promise<Started> {
    starting ??= import("./pglite-boot.js").then(async (boot) => {
      const opened = await boot.openPglite(
        config.dataDir ?? "memory://",
        notices.push,
        await boot.loadContrib(extensionNames),
      );
      return {
        db: opened.db,
        session: new PgliteSession(
          opened.db,
          opened.options,
          notices,
          () => {
            inflight += 1;
          },
          () => {
            inflight = Math.max(0, inflight - 1);
          },
          opened.fail,
        ),
      };
    });
    return starting;
  }

  async function lease(): Promise<DriverConnection> {
    if (closed) return rejectClosed();
    await slot.acquire(acquireMs);
    let started: Started;
    try {
      started = await boot();
    } catch (error) {
      slot.release();
      throw error;
    }
    const { session } = started;
    let released = false;
    return {
      execute: (text, params, options) => {
        const refused = noTimeout(options);
        if (refused !== undefined) return refused;
        return runCall(closed, options, (watch) => session.query(text, params, watch));
      },
      batch: (statements, options) => {
        const refused = noTimeout(options);
        if (refused !== undefined) return refused;
        return runCall(closed, options, async (watch) => {
          const { runAtomicBatch } = await import("./batch.js");
          return runAtomicBatch(session, statements, watch);
        });
      },
      async release() {
        if (released) return;
        released = true;
        try {
          const { resetQueried } = await import("./reserved.js");
          await resetQueried(session);
        } finally {
          slot.release();
        }
      },
    };
  }

  const pool: DriverPool = {
    capabilities: PGLITE_CAPABILITIES,
    execute(text, params, options) {
      const refused = noTimeout(options);
      if (refused !== undefined) return refused;
      return runCall(closed, options, async (watch) => {
        await slot.acquire(acquireMs);
        try {
          return await (await boot()).session.query(text, params, watch);
        } finally {
          slot.release();
        }
      });
    },
    async batch(statements, options) {
      const refused = noTimeout(options);
      if (refused !== undefined) return refused;
      const connection = await lease();
      try {
        return await connection.batch(statements, options);
      } finally {
        await connection.release();
      }
    },
    reserve: () => lease(),
    async describe(text): Promise<DescribeResult> {
      await slot.acquire(acquireMs);
      try {
        return await describeOnPglite((await boot()).db, text);
      } finally {
        slot.release();
      }
    },
    async listen(channel, onNotify) {
      const unlisten = await (await boot()).db.listen(channel, onNotify);
      return async () => {
        await unlisten();
      };
    },
    stats(): DriverStats {
      return { size: 1, idle: slot.idle, inflight, waiting: slot.waiting };
    },
    async close() {
      closed = true;
      if (starting === undefined) return;
      await (await starting).db.close();
    },
  };
  return Object.assign(pool, { prepareExtensions });
}

type Started = { readonly db: PGlite; readonly session: PgliteSession };

type WireMessage = {
  readonly name: string;
  readonly dataTypeIDs?: readonly number[];
  readonly fields?: readonly {
    readonly name: string;
    readonly dataTypeID: number;
    readonly tableID: number;
    readonly columnID: number;
  }[];
};

/**
 * Describes through PGlite's protocol helpers.
 *
 * `describeQuery` drops table OID and attnum. Parse, Describe, and Sync do
 * not bind or execute.
 *
 * @param db - Open database
 * @param text - One statement
 * @returns Parameter OIDs and result fields
 */
async function describeOnPglite(db: PGlite, text: string): Promise<DescribeResult> {
  // Static `protocol` makes the size stub's cold import fail. Load it here.
  const { protocol } = await import("@electric-sql/pglite");
  const serialize = protocol.serialize;
  const parse = serialize.parse({ text, types: [] });
  const described = serialize.describe({ type: "S" });
  const sync = serialize.sync();
  const bytes = new Uint8Array(parse.length + described.length + sync.length);
  bytes.set(parse, 0);
  bytes.set(described, parse.length);
  bytes.set(sync, parse.length + described.length);
  const result = await db.execProtocol(bytes, { throwOnError: false });
  const parameters: number[] = [];
  const fields: DescribeField[] = [];
  for (const message of result.messages as readonly WireMessage[]) {
    if (message.name === "parameterDescription" && message.dataTypeIDs !== undefined) {
      parameters.push(...message.dataTypeIDs);
    } else if (message.name === "rowDescription" && message.fields !== undefined) {
      for (const field of message.fields) {
        fields.push({
          name: field.name,
          typeOid: field.dataTypeID,
          tableOid: field.tableID,
          attnum: field.columnID,
        });
      }
    } else if (message.name === "error") throw message;
  }
  return {
    columns: fields.map((field) => field.name),
    parameterCount: parameters.length,
    parameters,
    fields,
  };
}

/**
 * A pool whose `close` marks this client only.
 *
 * The inner pool stays open. A later call fails as unavailable.
 * The body stays this small: the PGlite incremental figure is 11,982, 28 under its gate.
 *
 * @param pool - The caller's pool
 * @returns A pool the client owns
 */
export function seal(pool: DriverPool): DriverPool {
  let closed = 0;
  return new Proxy(pool, {
    get: (inner, key) =>
      key === "close"
        ? () => Promise.resolve((closed = 1))
        : ((inner = (inner as never)[key]),
          closed && (inner as { call?: unknown })?.call ? () => rejectClosed() : inner),
  });
}

class PgliteSession implements BatchSession {
  readonly canCancel = false;
  private transactionDepth = 0;
  private readonly db: PGlite;
  private readonly options: QueryOptions;
  private readonly notices: NoticeBuffer;
  private readonly enter: () => void;
  private readonly leave: () => void;
  private readonly fail: (error: unknown) => Promise<unknown>;

  /**
   * @param db - The database
   * @param options - Reused query options. Not allocated per call
   * @param notices - Notices for the statement in flight
   * @param enter - Marks one statement in flight
   * @param leave - Marks that statement finished
   * @param fail - Maps a driver exception. Loaded with the wire codecs
   */
  constructor(
    db: PGlite,
    options: QueryOptions,
    notices: NoticeBuffer,
    enter: () => void,
    leave: () => void,
    fail: (error: unknown) => Promise<unknown>,
  ) {
    this.db = db;
    this.options = options;
    this.notices = notices;
    this.enter = enter;
    this.leave = leave;
    this.fail = fail;
  }

  /** @inheritdoc */
  query(
    text: string,
    params: readonly WireValue[] | undefined,
    watch: Watch | undefined,
  ): Promise<ExecuteResult> {
    const why = watch?.reason();
    if (why === "timeout") return rejectTimedOut();
    if (why === "cancelled" || watch?.signal.aborted === true) return rejectCancelled();
    this.enter();
    const pending =
      params === undefined || params.length === 0
        ? this.db.query(text, undefined, this.options)
        : this.db.query(text, params as unknown as never[], this.options);
    return pending.then(
      (result) => {
        this.leave();
        this.note(text);
        return resultFrom(result, this.notices.take());
      },
      (error: unknown) => {
        this.leave();
        this.notices.take();
        return this.fail(stampQuery(error, text)).then((mapped) => {
          throw mapped;
        });
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

  /** Rolls back after a failed reserved session. Depth is cleared either way. */
  rollback(): Promise<void> {
    return this.query("ROLLBACK", undefined, undefined).then(
      () => {
        this.transactionDepth = 0;
      },
      (error: unknown) => {
        this.transactionDepth = 0;
        throw error;
      },
    );
  }

  private note(text: string): void {
    this.transactionDepth = nextTransactionDepth(this.transactionDepth, text);
  }
}

type NoticeBuffer = {
  push(notice: {
    severity?: string | undefined;
    code?: string | undefined;
    message?: string | undefined;
  }): void;
  take(): readonly Notice[];
};

function noticeBuffer(): NoticeBuffer {
  let notices: Notice[] | undefined;
  return {
    push(notice) {
      const severity = notice.severity ?? "";
      const message = notice.message ?? "";
      const code = notice.code !== undefined && notice.code.length > 0 ? notice.code : undefined;
      const entry: Notice =
        code === undefined ? { severity, message } : { severity, message, code };
      (notices ??= []).push(entry);
    },
    take() {
      const taken = notices ?? EMPTY_NOTICES;
      notices = undefined;
      return taken;
    },
  };
}

class Slot {
  private held = false;
  private readonly waiters: {
    resolve: () => void;
    timer: ReturnType<typeof setTimeout> | undefined;
  }[] = [];

  /**
   * Takes the single connection, or waits.
   *
   * @param acquireMs - Deadline. Omitted waits without one
   */
  acquire(acquireMs: number | undefined): Promise<void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
      };
      if (acquireMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          void driverErrors().then((errors) => {
            reject(errors.acquireTimeout());
          });
        }, acquireMs);
      }
      this.waiters.push(waiter);
    });
  }

  /** Hands the connection to the next waiter, or marks it idle. */
  release(): void {
    const next = this.waiters.shift();
    if (next === undefined) {
      this.held = false;
      return;
    }
    if (next.timer !== undefined) clearTimeout(next.timer);
    next.resolve();
  }

  /** One when the connection is not checked out. */
  get idle(): number {
    return this.held ? 0 : 1;
  }

  /** Callers waiting for the connection. */
  get waiting(): number {
    return this.waiters.length;
  }
}

function stampQuery(error: unknown, text: string): unknown {
  if (typeof error === "object" && error !== null && !("query" in error))
    Reflect.set(error, "query", text);
  return error;
}
