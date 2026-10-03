/**
 * Shared interactive session for drivers that speak wire text.
 *
 * The postgres.js adapter keeps its own session. node-postgres and Bun.sql
 * share this one: transaction depth, notices, and a watched cancel.
 */

import type { ExecuteResult, Notice, WireValue } from "../../contracts/driver.js";
import { driverErrors, rejectClosed } from "../failure.js";
import type { BatchSession } from "./batch.js";
import type { Watch } from "./call.js";
import { nextTransactionDepth } from "./call.js";
import { EMPTY_NOTICES, resultFrom } from "./result.js";

/** A query the session can abort when the driver supports it. */
export type WireQuery = Promise<unknown> & {
  cancel?(): void;
};

/** Sends one statement and returns the driver's own result. */
export type WireSender = (text: string, params: readonly WireValue[] | undefined) => WireQuery;

/** Notice slice shared by a pool. */
export type NoticeBuffer = {
  start(): number;
  since(start: number): readonly Notice[];
  push(notice: {
    readonly severity?: string | undefined;
    readonly message?: string | undefined;
    readonly code?: string | undefined;
  }): void;
};

/**
 * Quotes one identifier.
 *
 * @param name - Channel or cursor name
 * @returns A double-quoted identifier
 */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * An empty notice buffer the pool fills as the server sends notices.
 *
 * @returns The buffer
 */
export function noticeBuffer(): NoticeBuffer {
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
    start() {
      return notices?.length ?? 0;
    },
    since(start) {
      if (notices === undefined || notices.length === start) return EMPTY_NOTICES;
      return notices.slice(start);
    },
  };
}

/**
 * One connection's statement runner.
 *
 * `send` is the driver. This class owns depth, notices, and cancel tracking.
 */
export class WireSession implements BatchSession {
  readonly canCancel: boolean;
  private transactionDepth = 0;
  private readonly local = new Set<WireQuery>();
  private readonly send: WireSender;
  private readonly notices: NoticeBuffer;
  private readonly isClosed: () => boolean;
  private readonly onEnter: () => void;
  private readonly onLeave: () => void;
  private readonly shared: Set<WireQuery> | undefined;

  /**
   * @param send - Runs one statement on this connection
   * @param notices - Pool notice buffer
   * @param isClosed - Pool closed flag
   * @param canCancel - The driver aborts an in-flight statement
   * @param onEnter - Marks one statement in flight
   * @param onLeave - Marks that statement finished
   * @param shared - Pool-wide in-flight set, when this connection is reserved
   */
  constructor(
    send: WireSender,
    notices: NoticeBuffer,
    isClosed: () => boolean,
    canCancel: boolean,
    onEnter: () => void,
    onLeave: () => void,
    shared?: Set<WireQuery>,
  ) {
    this.send = send;
    this.notices = notices;
    this.isClosed = isClosed;
    this.canCancel = canCancel;
    this.onEnter = onEnter;
    this.onLeave = onLeave;
    this.shared = shared;
  }

  /** @inheritdoc */
  query(
    text: string,
    params: readonly WireValue[] | undefined,
    watch: Watch | undefined,
  ): Promise<ExecuteResult> {
    if (this.isClosed()) return rejectClosed();
    const start = this.notices.start();
    this.onEnter();
    const pending = this.send(text, params);
    if (watch === undefined) {
      return pending.then(
        (result) => {
          this.onLeave();
          this.note(text);
          return resultFrom(result, this.notices.since(start));
        },
        (error: unknown) => {
          this.onLeave();
          return driverErrors().then((errors) => Promise.reject(errors.mapDriverError(error)));
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
    for (const pending of this.local) pending.cancel?.();
  }

  private note(text: string): void {
    this.transactionDepth = nextTransactionDepth(this.transactionDepth, text);
  }

  private track(pending: WireQuery): void {
    this.local.add(pending);
    this.shared?.add(pending);
  }

  private untrack(pending: WireQuery): void {
    this.local.delete(pending);
    this.shared?.delete(pending);
  }

  private watched(
    pending: WireQuery,
    watch: Watch,
    start: number,
    text: string,
  ): Promise<ExecuteResult> {
    this.track(pending);
    const onAbort = (): void => {
      pending.cancel?.();
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

  private finishWatched(pending: WireQuery, watch: Watch, onAbort: () => void): void {
    this.onLeave();
    this.untrack(pending);
    watch.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Yields cursor chunks from one connection that is already checked out.
 *
 * The cursor is session-local. `ROLLBACK` in the end drops it.
 *
 * @param run - Executes on the checked-out connection
 * @param text - Query to stream
 * @param params - Wire parameters
 * @returns Chunks of wire rows
 */
export async function* cursorStream(
  run: (text: string, params?: readonly WireValue[]) => Promise<ExecuteResult>,
  text: string,
  params: readonly WireValue[] | undefined,
): AsyncIterable<readonly (readonly WireValue[])[]> {
  const name = "okm_stream";
  await run("BEGIN");
  try {
    await run(`DECLARE ${name} NO SCROLL CURSOR FOR ${text}`, params);
    for (;;) {
      const chunk = await run(`FETCH 64 FROM ${name}`);
      if (chunk.rows.length === 0) break;
      yield chunk.rows;
    }
  } finally {
    await run("ROLLBACK").catch(() => undefined);
  }
}

async function classify(error: unknown, watch: Watch): Promise<never> {
  const errors = await driverErrors();
  if (error instanceof errors.DriverError) return Promise.reject(error);
  const why = typeof error === "string" ? error : watch.reason();
  if (why === "timeout") {
    return Promise.reject(errors.timedOut(typeof error === "string" ? undefined : error));
  }
  const code = errors.errorField(error, "code") ?? errors.errorField(error, "errno");
  if (why === "cancelled" || code === "57014") {
    return Promise.reject(errors.cancelled(typeof error === "string" ? undefined : error));
  }
  return Promise.reject(errors.mapDriverError(error));
}
