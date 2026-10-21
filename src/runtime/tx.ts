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
import type { ObserveKey, RowCountMode } from "./observe-types.js";
import type { ObservingSlot, WriteDraft } from "./observe-emit.js";
import type { Hookm, Timeouts } from "./types.js";

/** What a write needs from the client: a pool, the default statement timeout, and observers. */
export type RunHost = {
  readonly pool: DriverPool;
  readonly timeouts?: Timeouts | undefined;
  readonly hookm?: readonly Hookm[] | undefined;
  /** Set when `connect({ onWrite })` registered a write observer. */
  readonly o?: ObservingSlot | undefined;
  /** Set when `connect({ onQuery })` registered a query observer. */
  readonly q?: object | undefined;
  /** Set inside a transaction. A unit of several statements is a savepoint there, not a transaction. */
  readonly tx?: object | undefined;
  /** Names the unit of an autocommit write or standalone batch. Set by `runWrite` while a write observer is attached. */
  readonly u?: object | undefined;
};

/** Per-statement observe metadata (no duration yet). */
export type WriteObserveMeta = {
  readonly table: string | null;
  readonly op: WriteDraft["op"];
  readonly tenant: WriteDraft["tenant"];
  readonly settings: readonly string[];
  readonly source: "client" | "raw";
  readonly tag?: string;
  /** The statement's SQL contains `RETURNING` (caller or observer). */
  readonly returning?: boolean;
  /** Primary-key columns in the result, when this table opted in. */
  readonly keyFields?: readonly {
    readonly field: string;
    readonly at: number;
    readonly decode: ((wire: string) => unknown) | undefined;
  }[];
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
  const scope = emit === undefined ? undefined : outer ? {} : emit.txScope(host.tx);
  const run: RunHost = outer && scope !== undefined ? { ...host, u: scope } : host;
  if (multiPhase) {
    if (emit !== undefined) emit.emitPhase({ ...host, observer, scope }, "start", 0);
    else hooks?.phase(host.hookm, "start", 0);
  } else if (observer !== undefined && scope !== undefined && outer) {
    observer.ensureUnit(scope);
  }
  const querying = host.q !== undefined;
  const timed = observer !== undefined || querying;
  const started = timed ? Date.now() : 0;
  const stack =
    querying && (host.q as { observeStack?: boolean }).observeStack === true
      ? new Error().stack
      : undefined;
  let results: readonly ExecuteResult[];
  try {
    results = single
      ? [await host.pool.execute(first.text, first.params, call)]
      : await host.pool.batch(statements, call);
  } catch (error) {
    if (timed && observer !== undefined && scope !== undefined) {
      noteWrites(observer, scope, statements.length, observe, Date.now() - started);
    }
    if (querying) {
      const { failWrite } = await import("./observe-query.js");
      failWrite(run, statements, observe, Date.now() - started, error, stack);
    }
    if (multiPhase) {
      if (emit !== undefined) emit.emitPhase({ ...host, observer, scope }, "rollback", 0);
      else hooks?.phase(host.hookm, "rollback", 0);
    } else if (observer !== undefined && scope !== undefined && outer) {
      observer.endAutocommit(scope, "rolled_back");
    }
    throw error;
  }
  const durationMs = timed ? Date.now() - started : 0;
  if (timed && observer !== undefined && scope !== undefined) {
    noteWrites(observer, scope, statements.length, observe, durationMs, results);
  }
  if (querying) {
    const { holdWrite } = await import("./observe-query.js");
    holdWrite(run, statements, observe, durationMs, results, stack);
  }
  if (multiPhase) {
    if (emit !== undefined) emit.emitPhase({ ...host, observer, scope }, "commit", 0);
    else hooks?.phase(host.hookm, "commit", 0);
  } else if (observer !== undefined && scope !== undefined && outer) {
    observer.endAutocommit(scope, "committed");
  }
  if (host.hookm !== undefined) {
    const heard = results.flatMap((result) => result.notices);
    if (heard.length > 0) (await import("./hookm.js")).notices(host.hookm, heard);
  }
  return results;
}

function noteWrites(
  observer: import("./observe-emit.js").ObserverController,
  scope: object,
  count: number,
  observe: readonly WriteObserveMeta[] | undefined,
  durationMs: number,
  results?: readonly ExecuteResult[],
): void {
  const drafts: WriteDraft[] = [];
  const handlerTag = observer.observeTag();
  for (let i = 0; i < count; i += 1) {
    const meta = observe?.[i] ?? observe?.[observe.length - 1];
    const result = results?.[i];
    const counted = rowCountOf(meta, result);
    const keys = keysOf(meta, result);
    const tag = meta?.tag ?? handlerTag;
    drafts.push({
      table: meta?.table ?? null,
      op: meta?.op ?? "raw",
      tenant: meta?.tenant ?? null,
      settings: meta?.settings ?? [],
      durationMs,
      source: meta?.source ?? "raw",
      rowCount: counted.rowCount,
      rowCountMode: counted.rowCountMode,
      ...(tag !== undefined ? { tag } : {}),
      ...(keys !== undefined ? { keys } : {}),
    });
  }
  observer.recordWrites(scope, drafts);
}

/**
 * Command-tag count for one statement.
 *
 * Missing `reported` (older fixtures) and a null tag are both `unknown`.
 * An upsert stays `changed` even when `RETURNING` ran. Every other op is
 * `returned` when the statement's SQL contained `RETURNING`.
 *
 * @param meta - Observe metadata for this statement
 * @param result - Driver result. Absent on a failed statement
 * @returns Count and mode
 */
export function rowCountOf(
  meta: WriteObserveMeta | undefined,
  result: ExecuteResult | undefined,
): { readonly rowCount: number | null; readonly rowCountMode: RowCountMode } {
  const reported = result?.reported;
  if (result === undefined || reported === undefined || reported === null) {
    return { rowCount: null, rowCountMode: "unknown" };
  }
  const op = meta?.op ?? "raw";
  const rowCountMode =
    op === "upsert" ? "changed" : meta?.returning === true ? "returned" : "changed";
  return { rowCount: reported, rowCountMode };
}

/**
 * Primary-key records from a statement that opted in.
 *
 * @param meta - Observe metadata
 * @param result - Driver result. Absent on failure, which omits keys
 * @returns One record per returned row, or `undefined` when keys were not requested
 */
function keysOf(
  meta: WriteObserveMeta | undefined,
  result: ExecuteResult | undefined,
): readonly ObserveKey[] | undefined {
  const fields = meta?.keyFields;
  if (fields === undefined || result === undefined) return undefined;
  const keys: ObserveKey[] = [];
  for (const row of result.rows) {
    const key: Record<string, unknown> = {};
    for (const field of fields) {
      const wire = row[field.at];
      key[field.field] =
        wire === null || wire === undefined
          ? null
          : field.decode === undefined
            ? wire
            : field.decode(wire);
    }
    keys.push(key);
  }
  return keys;
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
