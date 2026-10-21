/**
 * Writes on one endpoint.
 *
 * One statement uses the pool. Several statements use `batch`, which is atomic:
 * the adapter begins, commits, and rolls back, and inside an open transaction
 * the unit is a savepoint that never commits the outer transaction (D124). A
 * connection lost at commit is `outcome_unknown`. The interactive transaction
 * is `transaction.ts`; the public `batch` is `batch.ts`. Both load on first use.
 */

import type {
  DriverConnection,
  DriverPool,
  ExecuteOptions,
  ExecuteResult,
  Statement,
} from "../contracts/driver.js";
import type { ObservingSlot, WriteDraft } from "./observe-emit.js";
import type { Hookm, Timeouts } from "./types.js";

/** What a write needs from the client: a pool, the default statement timeout, and observers. */
export type RunHost = {
  readonly pool: DriverPool;
  readonly timeouts?: Timeouts | undefined;
  readonly hookm?: readonly Hookm[] | undefined;
  /** Set when `connect({ onWrite })` registered a write observer. */
  readonly o?: ObservingSlot | undefined;
  /** Set inside a transaction. A unit of several statements is a savepoint there, not a transaction. */
  readonly tx?: object | undefined;
};

/** Per-statement observe metadata (no duration yet). */
export type WriteObserveMeta = {
  readonly table: string | null;
  readonly op: WriteDraft["op"];
  readonly tenant: WriteDraft["tenant"];
  readonly settings: readonly string[];
  readonly source: "client" | "raw";
  readonly tag?: string;
};

/**
 * Runs write statements as one atomic unit.
 *
 * A call with no `timeout` takes `timeouts.statement`. Notices go to
 * `hookm.onNotice`. A unit of several statements is a transaction to
 * `hookm.onTransaction`. When `observing` is set, the same moments drive unit
 * events through one emission point.
 *
 * @param host - Pool, default timeout, and observers
 * @param statements - Statements in order
 * @param options - Signal and timeout for the whole unit
 * @param atomic - Use the driver's atomic `batch` even for one statement, so a failure carries `batchIndex`
 * @param observe - Per-statement metadata when a write observer is registered
 * @returns One result per statement
 */
export async function runWrite(
  host: RunHost,
  statements: readonly Statement[],
  options: ExecuteOptions | undefined,
  atomic?: true,
  observe?: readonly WriteObserveMeta[],
): Promise<readonly ExecuteResult[]> {
  if (statements.length === 0) return [];
  const first = statements[0];
  const limit = options?.timeout ?? host.timeouts?.statement;
  const call: ExecuteOptions | undefined =
    limit === undefined || limit === options?.timeout ? options : { ...options, timeout: limit };
  const single = statements.length === 1 && first !== undefined && atomic === undefined;
  const watching =
    host.o !== undefined || (host.hookm !== undefined && !single && host.tx === undefined);
  const emit = watching && host.o !== undefined ? await import("./observe-emit.js") : undefined;
  const hooks = watching && host.o === undefined ? await import("./hookm.js") : undefined;
  const observer =
    emit !== undefined && host.o !== undefined ? emit.resolveObserver(host.o) : undefined;
  const outer = host.tx === undefined;
  const multiPhase = !single && outer;
  if (multiPhase) {
    if (emit !== undefined) emit.emitPhase({ ...host, observer }, "start", 0);
    else hooks?.phase(host.hookm, "start", 0);
  } else if (observer !== undefined && outer) {
    observer.ensureUnit();
  }
  const timed = observer !== undefined;
  const started = timed ? Date.now() : 0;
  let results: readonly ExecuteResult[];
  try {
    results = single
      ? [await host.pool.execute(first.text, first.params, call)]
      : await host.pool.batch(statements, call);
  } catch (error) {
    if (timed && observer !== undefined) {
      noteWrites(observer, statements.length, observe, Date.now() - started);
    }
    if (multiPhase) {
      if (emit !== undefined) emit.emitPhase({ ...host, observer }, "rollback", 0);
      else hooks?.phase(host.hookm, "rollback", 0);
    } else if (observer !== undefined && outer) {
      observer.endAutocommit("rolled_back");
    }
    throw error;
  }
  const durationMs = timed ? Date.now() - started : 0;
  if (timed && observer !== undefined) noteWrites(observer, statements.length, observe, durationMs);
  if (multiPhase) {
    if (emit !== undefined) emit.emitPhase({ ...host, observer }, "commit", 0);
    else hooks?.phase(host.hookm, "commit", 0);
  } else if (observer !== undefined && outer) {
    observer.endAutocommit("committed");
  }
  if (host.hookm !== undefined) {
    const heard = results.flatMap((result) => result.notices);
    if (heard.length > 0) (await import("./hookm.js")).notices(host.hookm, heard);
  }
  return results;
}

function noteWrites(
  observer: import("./observe-emit.js").ObserverController,
  count: number,
  observe: readonly WriteObserveMeta[] | undefined,
  durationMs: number,
): void {
  const drafts: WriteDraft[] = [];
  for (let i = 0; i < count; i += 1) {
    const meta = observe?.[i] ?? observe?.[observe.length - 1];
    drafts.push({
      table: meta?.table ?? null,
      op: meta?.op ?? "raw",
      tenant: meta?.tenant ?? null,
      settings: meta?.settings ?? [],
      durationMs,
      source: meta?.source ?? "raw",
      ...(meta?.tag !== undefined ? { tag: meta.tag } : {}),
    });
  }
  observer.recordWrites(drafts);
}

/**
 * Runs statements on a connection the caller already reserved.
 *
 * An open transaction makes this a savepoint. The caller commits.
 *
 * @param connection - Reserved connection
 * @param statements - Statements in order
 * @param options - Signal and timeout
 * @returns One result per statement
 */
export function runWriteOn(
  connection: DriverConnection,
  statements: readonly Statement[],
  options: ExecuteOptions | undefined,
): Promise<readonly ExecuteResult[]> {
  return connection.batch(statements, options);
}
