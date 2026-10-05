/**
 * Public `tx()` (spec §15, §15.2).
 *
 * One transaction reserves one connection of the primary. Every statement of
 * the callback, its savepoints, and its batches run on that connection, and it
 * goes back to the pool at commit, rollback, or cancellation. The callback gets
 * a client built on a pool that is a facade over that connection, so reads,
 * writes, includes, presets, tenancy, and archive handling are the ones the
 * caller's client already has. Loaded the first time `tx()` is called.
 */

import { isConnectionLost } from "../contracts/connection.js";
import type {
  DriverConnection,
  DriverPool,
  ExecuteOptions,
  ExecuteResult,
  Statement,
  WireValue,
} from "../contracts/driver.js";
import { OkmError } from "../contracts/error.js";
import { openClient, settleCall, withHttp, type Session } from "./client.js";
import { fail, isRecord, rejectKeys } from "./plan.js";
import type { CallOptions, TxOptions } from "./types.js";

type After = () => void | Promise<void>;

const BEGIN = {
  "read committed": "BEGIN ISOLATION LEVEL READ COMMITTED",
  "repeatable read": "BEGIN ISOLATION LEVEL REPEATABLE READ",
  serializable: "BEGIN ISOLATION LEVEL SERIALIZABLE",
} as const;

/** The part of `session.tx` this module reads back on a nested call. */
type Held = {
  readonly extras: object;
  readonly depth: number;
  readonly state: Frame;
  readonly after: After[];
};

/**
 * One transaction's connection and the reasons it can no longer run statements.
 *
 * `failed` is the first statement error that left the transaction aborted (or a
 * cancel or timeout, which fail it even when the database could go on). `stopped`
 * is set by the transaction's own deadline, idle limit, or `signal`. `done` is
 * set when the connection has been given back.
 */
class Frame {
  done = false;
  failed: unknown = undefined;
  stopped: OkmError | undefined = undefined;
  savepoints = 0;
  /** Aborts the statements in flight. Present only when something can stop the transaction. */
  readonly signal: AbortSignal | undefined;
  private readonly abort: AbortController | undefined;
  private active = 0;
  /** Rejects when the transaction is stopped, so a callback that never settles does not hold it. */
  readonly halt: Promise<never>;
  private idle: ReturnType<typeof setTimeout> | undefined = undefined;
  private cut: (error: OkmError) => void = () => undefined;
  readonly conn: DriverConnection;
  private readonly idleMs: number | undefined;

  constructor(conn: DriverConnection, idleMs: number | undefined, stoppable: boolean) {
    this.conn = conn;
    this.idleMs = idleMs;
    this.abort = stoppable ? new AbortController() : undefined;
    this.signal = this.abort?.signal;
    this.halt = new Promise<never>((_, reject) => {
      this.cut = reject;
    });
    this.halt.catch(() => undefined);
  }

  /** Stops the transaction: cancels the statement in flight and fails what runs next. */
  stop(error: OkmError): void {
    if (this.done || this.stopped !== undefined) return;
    this.stopped = error;
    this.abort?.abort();
    this.cut(error);
  }

  /** Throws when the transaction cannot run another statement. */
  check(): void {
    if (this.done) {
      throw new OkmError(
        "driver",
        "The transaction has finished. Use the client the callback received only while the callback runs.",
        { kind: "driver" },
      );
    }
    if (this.stopped !== undefined) throw this.stopped;
  }

  /** A statement starts. The idle clock stops. */
  enter(): void {
    this.active += 1;
    this.rest();
  }

  /** A statement ends. The idle clock starts when none is left in flight. */
  leave(): void {
    this.active -= 1;
    if (this.active === 0) this.arm();
  }

  /** Starts the idle clock. It runs while no statement is in flight. */
  arm(): void {
    this.rest();
    if (this.idleMs === undefined || this.done || this.active > 0) return;
    this.idle = setTimeout(() => {
      this.stop(
        new OkmError(
          "timeout",
          `The transaction sat idle for ${String(this.idleMs)} ms (timeouts.idleInTransaction).`,
          { kind: "timeout" },
        ),
      );
    }, this.idleMs);
  }

  /** Stops the idle clock. */
  rest(): void {
    if (this.idle !== undefined) clearTimeout(this.idle);
    this.idle = undefined;
  }

  /** Records a failed statement. A batch is a savepoint, so only a cancel or a timeout fails the transaction. */
  note(error: unknown, whole: boolean): void {
    const kind = (error as { readonly kind?: unknown } | null)?.kind;
    if (!whole || kind === "cancelled" || kind === "timeout") this.failed ??= error;
  }
}

/**
 * Runs `fn` in a transaction, or in a savepoint when one is already open.
 *
 * @param session - Client session
 * @param args - `[fn]` or `[options, fn]`
 * @returns What `fn` returned
 */
export async function tx(session: Session, args: readonly unknown[]): Promise<unknown> {
  const fn = typeof args[0] === "function" ? args[0] : args[1];
  const given = typeof args[0] === "function" ? {} : (args[0] ?? {});
  try {
    if (typeof fn !== "function")
      fail("OKM1121", "tx expects a callback: tx(fn) or tx(options, fn).");
    if (!isRecord(given)) fail("OKM1121", "tx options must be an object.");
    rejectKeys(given, ["isolation", "retry", "signal", "timeout"], "tx");
    const options = given as TxOptions;
    check(options);
    const call = fn as (t: unknown) => Promise<unknown>;
    return session.tx === undefined
      ? await outer(session, call, options)
      : await nested(session, call, options);
  } catch (error) {
    return failWith(session, error);
  }
}

/** Maps a driver error. An error the caller threw, or one already mapped, goes out unchanged. */
function failWith(session: Session, error: unknown): Promise<never> {
  if (error instanceof OkmError || !(error instanceof Error) || error.name !== "DriverError") {
    return Promise.reject(error);
  }
  return settleCall(session, error);
}

function check(options: TxOptions): void {
  if (options.isolation !== undefined && !Object.hasOwn(BEGIN, options.isolation)) {
    fail("OKM1120", `isolation must be one of: ${Object.keys(BEGIN).join(", ")}.`);
  }
  const { retry, timeout } = options;
  if (retry !== undefined && (!Number.isInteger(retry) || retry < 0)) {
    fail("OKM1121", "retry must be an integer from 0 up.");
  }
  if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
    fail("OKM1121", "timeout must be a number of milliseconds above 0.");
  }
}

/** The outermost `tx()`: reserve a connection, run, retry on a declared serialization failure or deadlock. */
async function outer(
  session: Session,
  fn: (t: unknown) => Promise<unknown>,
  options: TxOptions,
): Promise<unknown> {
  const pool = session.pool;
  if (pool.reserve === undefined || pool.capabilities.transactions !== "interactive") {
    throw new OkmError(
      "OKM1111",
      `tx() needs a driver with transactions: "interactive". This driver has "${pool.capabilities.transactions}".`,
      withHttp(session.http, {
        fix: { summary: "Use batch() for an atomic unit on this driver." },
      }),
    );
  }
  await session.connected;
  const started = Date.now();
  const limit = options.timeout ?? session.timeouts?.transaction;
  const deadline = limit === undefined ? undefined : started + limit;
  const retries = options.retry ?? 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await once(session, fn, options, deadline);
    } catch (error) {
      const kind = error instanceof OkmError ? error.kind : undefined;
      if (attempt >= retries || (kind !== "serialization" && kind !== "deadlock")) throw error;
      await pause(attempt);
      if (options.signal?.aborted === true) throw cancelled();
      if (deadline !== undefined && Date.now() >= deadline) throw timedOut();
    }
  }
}

/** A short random wait before a retry, so two transactions that collided do not collide again. */
function pause(attempt: number): Promise<void> {
  const ms = Math.random() * Math.min(100, 4 * 2 ** attempt);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cancelled(): OkmError {
  return new OkmError("cancelled", "The transaction was cancelled.", { kind: "cancelled" });
}

function timedOut(): OkmError {
  return new OkmError("timeout", "The transaction timed out.", { kind: "timeout" });
}

/** One attempt: one reserved connection, one transaction. */
async function once(
  session: Session,
  fn: (t: unknown) => Promise<unknown>,
  options: TxOptions,
  deadline: number | undefined,
): Promise<unknown> {
  const signal = options.signal;
  if (signal?.aborted === true) throw cancelled();
  if (deadline !== undefined && Date.now() >= deadline) throw timedOut();
  const conn = await reserve(session);
  const frame = new Frame(
    conn,
    session.timeouts?.idleInTransaction,
    signal !== undefined || deadline !== undefined,
  );
  const after: After[] = [];
  const hear = session.hookm === undefined ? undefined : await import("./hookm.js");
  const onAbort = (): void => frame.stop(cancelled());
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer =
    deadline === undefined
      ? undefined
      : setTimeout(() => frame.stop(timedOut()), deadline - Date.now());
  let began = false;
  let committing = false;
  let committed = false;
  try {
    await step(
      session,
      frame,
      options.isolation === undefined ? "BEGIN" : BEGIN[options.isolation],
    );
    began = true;
    hear?.phase(session.hookm, "start", 0);
    frame.arm();
    const t = openClient(held(session, frame, after, 0));
    const value = await Promise.race([fn(t), frame.halt]);
    frame.check();
    if (frame.failed !== undefined) throw frame.failed;
    frame.rest();
    committing = true;
    await commit(session, frame);
    committed = true;
    return value;
  } catch (error) {
    if (began && !committed) {
      // A failed COMMIT has ended the transaction already, and a lost one leaves no connection to ask.
      if (!committing) await frame.conn.execute("ROLLBACK").catch(() => undefined);
      if (!(error instanceof OkmError && error.kind === "outcome_unknown")) {
        hear?.phase(session.hookm, "rollback", 0);
      }
    }
    return await failWith(session, error);
  } finally {
    frame.rest();
    frame.done = true;
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    try {
      await conn.release();
    } catch (error) {
      hear?.report(session, error);
    }
    if (committed) {
      hear?.phase(session.hookm, "commit", 0);
      await run(session, after, hear);
    }
  }
}

/** Reserves the connection. A failure is mapped here: OKM1846 passes through, anything else is a driver error. */
async function reserve(session: Session): Promise<DriverConnection> {
  try {
    return await (session.pool.reserve as () => Promise<DriverConnection>)();
  } catch (error) {
    return failWith(session, error);
  }
}

/** Runs one control statement on the connection, outside the facade. */
function step(session: Session, frame: Frame, text: string): Promise<ExecuteResult> {
  return frame.conn.execute(text).catch((error: unknown) => failWith(session, error));
}

/**
 * Commits. A connection that goes away while COMMIT is on the wire leaves the
 * outcome unknown (OKM1401): the commit may have landed. It is never retried.
 */
async function commit(session: Session, frame: Frame): Promise<void> {
  try {
    await frame.conn.execute("COMMIT");
  } catch (error) {
    if (isConnectionLost(error)) {
      throw new OkmError(
        "OKM1401",
        "The commit was sent and its result never arrived. The transaction may or may not have committed.",
        withHttp(session.http, {
          kind: "outcome_unknown",
          cause: error,
          fix: {
            summary: "Check whether the write landed, using an idempotency key, before retrying.",
          },
        }),
      );
    }
    throw error;
  }
}

/** Calls the `afterCommit` callbacks in order. An error is reported and never reaches the caller. */
async function run(
  session: Session,
  after: readonly After[],
  hear: typeof import("./hookm.js") | undefined,
): Promise<void> {
  for (const callback of after) {
    try {
      await callback();
    } catch (error) {
      if (hear !== undefined) hear.report(session, error);
      else (await import("./hookm.js")).report(session, error);
    }
  }
}

/** A `tx()` inside a transaction: a savepoint on the same connection. */
async function nested(
  session: Session,
  fn: (t: unknown) => Promise<unknown>,
  options: TxOptions,
): Promise<unknown> {
  if (Object.keys(options).length > 0) {
    fail(
      "OKM1121",
      "isolation, retry, timeout, and signal belong to the outermost tx(). A nested tx() is a savepoint on the same transaction.",
    );
  }
  const { state: frame, depth } = session.tx as Held;
  frame.check();
  frame.savepoints += 1;
  const name = `okm_t${String(frame.savepoints)}`;
  const hear = session.hookm === undefined ? undefined : await import("./hookm.js");
  const saved = frame.failed;
  const after: After[] = [];
  let released = false;
  try {
    await step(session, frame, `SAVEPOINT ${name}`);
    hear?.phase(session.hookm, "start", depth + 1);
    const t = openClient(held(session, frame, after, depth + 1));
    const value = await Promise.race([fn(t), frame.halt]);
    frame.check();
    if (frame.failed !== saved) throw frame.failed;
    await step(session, frame, `RELEASE SAVEPOINT ${name}`);
    released = true;
    hear?.phase(session.hookm, "commit", depth + 1);
    (session.tx as Held).after.push(...after);
    return value;
  } catch (error) {
    if (!released && frame.stopped === undefined) {
      // The savepoint absorbs the failure: the transaction goes on if the caller handles the error.
      await frame.conn.execute(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
      frame.failed = saved;
      hear?.phase(session.hookm, "rollback", depth + 1);
    }
    return await failWith(session, error);
  }
}

/**
 * The session of the client a transaction (or a savepoint) hands out.
 *
 * Its pool is a facade over the reserved connection. `extras` are the methods only
 * this client has: `afterCommit` and `advisoryLock`.
 */
function held(session: Session, frame: Frame, after: After[], depth: number): Session {
  const base = session.pool;
  const guarded = async <T>(run: () => Promise<T>, whole: boolean): Promise<T> => {
    frame.check();
    frame.enter();
    try {
      return await run();
    } catch (error) {
      frame.note(error, whole);
      throw error;
    } finally {
      frame.leave();
    }
  };
  const pool: DriverPool =
    depth === 0
      ? {
          capabilities: base.capabilities,
          execute: (text: string, params?: readonly WireValue[], options?: ExecuteOptions) =>
            guarded(() => frame.conn.execute(text, params, stoppable(frame, options)), false),
          batch: (statements: readonly Statement[], options?: ExecuteOptions) =>
            guarded(() => frame.conn.batch(statements, stoppable(frame, options)), true),
          stats: () => base.stats(),
          close: () => Promise.resolve(),
        }
      : base;
  const next: Session = {
    ...session,
    pool,
    tx: {
      depth,
      state: frame,
      after,
      extras: {
        afterCommit(callback: After) {
          if (typeof callback !== "function") {
            fail("OKM1121", "afterCommit expects a function.");
          }
          frame.check();
          after.push(callback);
        },
        async advisoryLock(key: string | number | bigint, options?: CallOptions) {
          const [text, wire] = lockKey(key);
          try {
            await pool.execute(text, [wire], callOf(options));
          } catch (error) {
            await failWith(next, error);
          }
        },
      },
    } as Held,
  };
  return next;
}

/**
 * Adds the transaction's own signal to a statement's options, so stopping the
 * transaction cancels the statement in flight. A transaction nothing can stop
 * leaves the statement as the caller wrote it.
 */
function stoppable(frame: Frame, options: ExecuteOptions | undefined): ExecuteOptions | undefined {
  const own = frame.signal;
  if (own === undefined) return options;
  return {
    ...options,
    signal: options?.signal === undefined ? own : AbortSignal.any([options.signal, own]),
  };
}

/** The statement and the wire value for `pg_advisory_xact_lock`. A string is hashed to 64 bits. */
function lockKey(key: string | number | bigint): readonly [string, string] {
  if (typeof key === "string") {
    return ["select pg_advisory_xact_lock(hashtextextended($1, 0))", key];
  }
  const fits =
    typeof key === "number"
      ? Number.isSafeInteger(key)
      : typeof key === "bigint" && key >= -(2n ** 63n) && key < 2n ** 63n;
  if (!fits)
    fail(
      "OKM1121",
      "advisoryLock takes a string, a safe integer, or a bigint that fits in 64 bits.",
    );
  return ["select pg_advisory_xact_lock($1::bigint)", String(key)];
}

function callOf(options: CallOptions | undefined): ExecuteOptions | undefined {
  if (options?.signal === undefined && options?.timeout === undefined) return undefined;
  return {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
  };
}
