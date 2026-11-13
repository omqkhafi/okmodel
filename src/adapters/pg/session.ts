/**
 * Shared interactive session for drivers that speak wire text.
 *
 * The postgres.js adapter keeps its own session. node-postgres and Bun.sql
 * share this one: transaction depth, notices, and a watched cancel.
 */

import type { ExecuteResult, Notice, WireValue } from "../../contracts/driver.js";
import { rejectClosed } from "../failure.js";
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
    let pending: WireQuery;
    try {
      pending = this.send(text, params);
    } catch (error) {
      this.onLeave();
      return import("./session-extra.js").then((mod) => mod.rejectMapped(error, text));
    }
    if (watch === undefined) {
      return pending.then(
        (result) => {
          this.onLeave();
          this.note(text);
          return resultFrom(result, this.notices.since(start));
        },
        (error: unknown) => {
          this.onLeave();
          return import("./session-extra.js").then((mod) => mod.rejectMapped(error, text));
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
    // Attached before the lazy module loads, so an abort in that turn still cancels.
    if (watch.signal.aborted) onAbort();
    else watch.signal.addEventListener("abort", onAbort, { once: true });
    // The settlement handlers attach when the module loads. Hold the rejection
    // until then so it cannot surface as unhandled.
    pending.catch(() => undefined);
    const ctx = {
      leave: () => {
        this.onLeave();
      },
      untrack: () => {
        this.untrack(pending);
      },
      note: () => {
        this.note(text);
      },
      notices: this.notices,
      start,
      text,
    };
    return import("./session-extra.js").then(
      (mod) => mod.settleWatched(pending, watch, onAbort, ctx),
      (error: unknown) => {
        ctx.leave();
        ctx.untrack();
        watch.signal.removeEventListener("abort", onAbort);
        throw error;
      },
    );
  }
}
