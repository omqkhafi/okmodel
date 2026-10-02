/**
 * PGlite adapter (`okmodel/pg/pglite`).
 *
 * One database is a pool of one. `cancel` is false: a statement already
 * running cannot be aborted. `@electric-sql/pglite` is a peer of this entry.
 */

import { PGlite, type QueryOptions } from "@electric-sql/pglite";

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
import { PGLITE_CAPABILITIES } from "../capabilities.js";
import { acquireTimeout, cancelled, DriverError, mapDriverError, timedOut } from "../error.js";
import { type BatchSession, nextTransactionDepth, runAtomicBatch } from "./batch.js";
import { runCall, type Watch } from "./call.js";
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

const RESET_ALL = "RESET ALL";
const UNLOCK = "SELECT pg_advisory_unlock_all()";

/**
 * Opens a PGlite pool of one.
 *
 * @param config - Data directory and acquire timeout. `max` is ignored
 * @returns The pool
 */
export async function open(config: PgliteConfig = {}): Promise<DriverPool> {
  const db = new PGlite({
    dataDir: config.dataDir ?? "memory://",
    parsers: WIRE,
    serializers: WIRE,
  });
  await db.waitReady;
  const acquireMs = config.timeouts?.acquire;
  const slot = new Slot();
  const notices = noticeBuffer();
  const queryOptions: QueryOptions = {
    rowMode: "array",
    parsers: WIRE,
    serializers: WIRE,
    onNotice(notice) {
      notices.push(notice);
    },
  };
  let closed = false;
  let inflight = 0;
  const session = new PgliteSession(
    db,
    queryOptions,
    notices,
    () => {
      inflight += 1;
    },
    () => {
      inflight = Math.max(0, inflight - 1);
    },
  );

  async function lease(): Promise<DriverConnection> {
    if (closed) throw new DriverError("The pool is closed.");
    await slot.acquire(acquireMs);
    let released = false;
    return {
      execute: (text, params, options) =>
        runCall(closed, options, (watch) => session.query(text, params, watch)),
      batch: (statements, options) =>
        runCall(closed, options, (watch) => runAtomicBatch(session, statements, watch)),
      async release() {
        if (released) return;
        released = true;
        try {
          await reset(session);
        } finally {
          slot.release();
        }
      },
    };
  }

  return {
    capabilities: PGLITE_CAPABILITIES,
    execute(text, params, options) {
      return runCall(closed, options, async (watch) => {
        await slot.acquire(acquireMs);
        try {
          return await session.query(text, params, watch);
        } finally {
          slot.release();
        }
      });
    },
    async batch(statements, options) {
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
        const described = await db.describeQuery(text);
        return {
          columns: described.resultFields.map((field) => field.name),
          parameterCount: described.queryParams.length,
        };
      } finally {
        slot.release();
      }
    },
    async listen(channel, onNotify) {
      const unlisten = await db.listen(channel, onNotify);
      return async () => {
        await unlisten();
      };
    },
    stats(): DriverStats {
      return { size: 1, idle: slot.idle, inflight, waiting: slot.waiting };
    },
    async close() {
      closed = true;
      await db.close();
    },
  };
}

class PgliteSession implements BatchSession {
  readonly canCancel = false;
  private transactionDepth = 0;
  private readonly db: PGlite;
  private readonly options: QueryOptions;
  private readonly notices: NoticeBuffer;
  private readonly enter: () => void;
  private readonly leave: () => void;

  /**
   * @param db - The database
   * @param options - Reused query options. Not allocated per call
   * @param notices - Notices for the statement in flight
   * @param enter - Marks one statement in flight
   * @param leave - Marks that statement finished
   */
  constructor(
    db: PGlite,
    options: QueryOptions,
    notices: NoticeBuffer,
    enter: () => void,
    leave: () => void,
  ) {
    this.db = db;
    this.options = options;
    this.notices = notices;
    this.enter = enter;
    this.leave = leave;
  }

  /** @inheritdoc */
  query(
    text: string,
    params: readonly WireValue[] | undefined,
    watch: Watch | undefined,
  ): Promise<ExecuteResult> {
    const why = watch?.reason();
    if (why === "timeout") return Promise.reject(timedOut());
    if (why === "cancelled" || watch?.signal.aborted === true) return Promise.reject(cancelled());
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
        throw mapDriverError(error);
      },
    );
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

  /** @inheritdoc */
  savepoint(name: string): Promise<void> {
    return this.query(`SAVEPOINT ${name}`, undefined, undefined).then(() => undefined);
  }

  /** @inheritdoc */
  releaseSavepoint(name: string): Promise<void> {
    return this.query(`RELEASE SAVEPOINT ${name}`, undefined, undefined).then(() => undefined);
  }

  /** @inheritdoc */
  rollbackTo(name: string): Promise<void> {
    return this.query(`ROLLBACK TO SAVEPOINT ${name}`, undefined, undefined).then(() => undefined);
  }

  /** @inheritdoc */
  inTransaction(): boolean {
    return this.transactionDepth > 0;
  }

  private control(text: "BEGIN" | "COMMIT", watch: Watch | undefined): Promise<void> {
    return this.query(text, undefined, watch).then(() => undefined);
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
          reject(acquireTimeout());
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

async function reset(session: PgliteSession): Promise<void> {
  if (session.inTransaction()) await session.rollback().catch(() => undefined);
  try {
    await session.query(RESET_ALL, undefined, undefined);
    await session.query(UNLOCK, undefined, undefined);
  } catch {
    await session.rollback().catch(() => undefined);
    await session.query(RESET_ALL, undefined, undefined);
    await session.query(UNLOCK, undefined, undefined);
  }
}

function wireMap(oids: readonly number[]): Record<number, (value: string) => string> {
  const parsers: Record<number, (value: string) => string> = {};
  for (const oid of oids) parsers[oid] = (value) => value;
  return parsers;
}

/** Identity codecs. Values stay wire text. The dialect owns parsing. */
const WIRE = wireMap([
  16, 17, 20, 21, 23, 25, 114, 700, 701, 1043, 1082, 1114, 1184, 1700, 2950, 3802, 1000, 1005, 1007,
  1009, 1016, 1115, 1182, 1185, 1231, 199, 3807,
]);
