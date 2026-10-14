/**
 * Keyset batches for `.stream()` (spec §10).
 *
 * Loaded the first time `.stream()` is iterated. A find that is only awaited
 * does not load it. Each batch is one finished `page` query: fetch, yield,
 * then fetch the next. A `break` does not hold a connection. A server cursor
 * is not used, so the driver `stream` flag is not read.
 */

import { OkmError } from "../contracts/error.js";
import { attachHttp, type Mods, type Session } from "./client.js";
import { build as pageOf } from "./page.js";
import {
  fail,
  indexes,
  isRecord,
  readLimit,
  rejectKeys,
  type ArchiveView,
  type ReadCall,
} from "./plan.js";

/** Rows in one query when the caller does not pass `batch`. */
const DEFAULT_BATCH = 1000;

/** Largest `limit` Postgres accepts as a 32-bit integer. */
const MAX_BATCH = 2_147_483_647;

/**
 * Yields decoded rows, one keyset batch at a time.
 *
 * @param session - Connected pool and HTTP statuses
 * @param call - The find being streamed
 * @param mods - `.all` reason and presets
 * @param view - Archive visibility
 * @param batchOptions - `{ batch }`, or omitted for {@link DEFAULT_BATCH}
 * @param log - Attaches the session logger and returns the error
 * @returns One row at a time
 */
export async function* streamRows(
  session: Session,
  call: ReadCall,
  mods: Mods,
  view: ArchiveView | undefined,
  batchOptions: object | undefined,
  log: (error: OkmError) => OkmError,
): AsyncIterable<unknown> {
  const stop = (error: OkmError): never => {
    throw log(attachHttp(session.http, error));
  };
  let batch: number;
  let total: number | undefined;
  let signal: AbortSignal | undefined;
  let deadline: number | undefined;
  try {
    if (call.op !== "find") {
      fail("OKM1120", `stream() reads rows from find(). ${call.op}() returns one value.`);
    }
    if (call.search !== undefined) {
      fail(
        "OKM1120",
        "stream() does not take search in this version. Use find({ search, limit }) for a ranked list.",
        "Ranked pages are later. find({ search, limit }) returns one ranked list.",
      );
    }
    if (Array.isArray(call.select) && call.select.some((item) => typeof item !== "string")) {
      fail(
        "OKM1120",
        "stream() does not take a window. The keyset cursor has no window value to encode.",
      );
    }
    const indexed = indexes(session.schema).get(call.table);
    if (indexed === undefined) fail("OKM1120", `Table ${call.table} is not in the schema.`);
    if (indexed.model.primary.length === 0) {
      fail(
        "OKM1120",
        `stream() needs a primary key on ${indexed.model.name}. A keyset batch orders by that key.`,
        "Give the table a primary key. stream() orders by it.",
      );
    }
    batch = readBatch(batchOptions);
    if (mods.all !== undefined && mods.all.length === 0) {
      fail("OKM1101", "find() .all needs a reason.");
    }
    if (call.limit !== undefined) total = readLimit(call.limit);
    else if (mods.all === undefined) {
      fail("OKM1101", "find() needs a limit, or .all(reason) when the full set is intentional.");
    }
    const timeout = call.timeout;
    if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
      fail("OKM1121", "timeout must be a number of milliseconds above 0.");
    }
    signal = signalOf(call.signal);
    deadline = timeout === undefined ? undefined : Date.now() + timeout;
  } catch (error) {
    if (error instanceof OkmError) stop(error);
    throw error;
  }
  if (total === 0) return;

  const cancel = session.pool.capabilities.cancel === true;
  const statement = session.timeouts?.statement;
  // One object for every batch. The router writes the first endpoint into it.
  const pin: { name?: string } = {};
  let after: string | undefined;
  let left = total;
  let pending: Promise<unknown> | undefined;
  try {
    while (left === undefined || left > 0) {
      if (signal?.aborted === true) {
        stop(new OkmError("cancelled", "The stream was cancelled.", { kind: "cancelled" }));
      }
      const remaining = timeLeft(deadline);
      const size = left === undefined ? batch : Math.min(batch, left);
      const handle = pageOf(
        session,
        call.table,
        pageFields(call, size, after, signal, batchTimeout(remaining, cancel, statement)),
        mods,
        view,
        pin,
      );
      pending = handle;
      const value = asPage(await handle);
      pending = undefined;
      for (const row of value.items) {
        yield row;
        if (left !== undefined) {
          left -= 1;
          if (left === 0) return;
        }
      }
      if (value.next === null || value.items.length < size) return;
      after = value.next;
    }
  } catch (error) {
    if (
      error instanceof OkmError &&
      error.kind === "timeout" &&
      error.message === "The stream timed out."
    ) {
      stop(error);
    }
    throw error;
  } finally {
    if (pending !== undefined) {
      void pending.then(
        () => undefined,
        () => undefined,
      );
    }
  }
}

/**
 * Reads `{ batch }` and refuses any other key.
 *
 * @param options - Caller options, or omitted
 * @returns The batch size
 */
function readBatch(options: object | undefined): number {
  if (options === undefined) return DEFAULT_BATCH;
  if (!isRecord(options)) fail("OKM1120", "stream() takes an object. Pass { batch }.");
  rejectKeys(options, ["batch"], "stream");
  const batch = options.batch;
  if (batch === undefined) return DEFAULT_BATCH;
  if (typeof batch !== "number" || !Number.isInteger(batch) || batch < 1 || batch > MAX_BATCH) {
    fail("OKM1121", "stream() batch must be an integer from 1 to 2147483647.");
  }
  return batch;
}

/**
 * Page options for one batch. The find's `limit` is the stream total, not this size.
 *
 * @param call - The find
 * @param size - Rows this batch asks for
 * @param after - Cursor from the previous batch
 * @param signal - Aborts this batch
 * @param timeout - Milliseconds left for this batch, on a driver that can cancel
 * @returns Options `page` accepts
 */
function pageFields(
  call: ReadCall,
  size: number,
  after: string | undefined,
  signal: AbortSignal | undefined,
  timeout: number | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { limit: size };
  if (call.where !== undefined) out.where = call.where;
  if (call.select !== undefined) out.select = call.select;
  if (call.orderBy !== undefined) out.orderBy = call.orderBy;
  if (call.include !== undefined) out.include = call.include;
  if (call.route !== undefined) out.route = call.route;
  if (after !== undefined) out.after = after;
  if (signal !== undefined) out.signal = signal;
  if (timeout !== undefined) out.timeout = timeout;
  return out;
}

/**
 * Milliseconds still left in the stream budget.
 *
 * @param deadline - Absolute time the stream must stop, when `timeout` was set
 * @returns Time left, or `undefined` when the stream has no budget
 */
function timeLeft(deadline: number | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  const left = deadline - Date.now();
  if (left <= 0) throw new OkmError("timeout", "The stream timed out.", { kind: "timeout" });
  return left;
}

/**
 * Timeout passed to one batch.
 *
 * A driver that cannot cancel refuses a positive timeout, so the budget is
 * checked before the batch instead. A driver that can cancel gets the time
 * still left, and a shorter session statement timeout when one is set.
 *
 * @param remaining - Time left in the stream budget
 * @param cancel - Driver `cancel` flag
 * @param statement - Session statement timeout
 * @returns The timeout for this query, or `undefined` to leave the session default
 */
function batchTimeout(
  remaining: number | undefined,
  cancel: boolean,
  statement: number | undefined,
): number | undefined {
  if (!cancel || remaining === undefined) return undefined;
  if (statement !== undefined && statement > 0 && statement < remaining) return statement;
  return remaining;
}

/**
 * Reads an AbortSignal off the find.
 *
 * @param value - The caller's `signal`
 * @returns The signal, when it has `aborted`
 */
function signalOf(value: unknown): AbortSignal | undefined {
  if (typeof value === "object" && value !== null && "aborted" in value) {
    return value as AbortSignal;
  }
  return undefined;
}

/**
 * Reads `{ items, next }` from one page.
 *
 * @param value - What `page` resolved to
 * @returns The rows and the cursor
 */
function asPage(value: unknown): {
  readonly items: readonly unknown[];
  readonly next: string | null;
} {
  if (typeof value !== "object" || value === null || !("items" in value) || !("next" in value)) {
    throw new OkmError("OKM1120", "stream() did not get a page of rows.");
  }
  const items = value.items;
  const next = value.next;
  if (!Array.isArray(items) || (next !== null && typeof next !== "string")) {
    throw new OkmError("OKM1120", "stream() did not get a page of rows.");
  }
  return { items, next };
}
