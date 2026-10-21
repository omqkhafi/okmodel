/**
 * Public `batch` (spec §15, batch contract).
 *
 * Plans each operation, joins their statements, and runs them as one atomic
 * unit on the primary. Results come back in the order given. A failure rolls
 * everything back and the error carries `batchIndex`, the failing operation,
 * or `null` when the commit failed. Inside `tx()` the unit is a savepoint, so
 * the transaction survives. Loaded the first time a batch is awaited.
 */

import type { ExecuteOptions, ExecuteResult, Statement } from "../contracts/driver.js";
import { OkmError } from "../contracts/error.js";
import { settleCall, withHttp, type Session } from "./client.js";
import { fail, isRecord, rejectKeys } from "./plan.js";
import { refuseUncancellableTimeout } from "./inflight.js";
import { runWrite } from "./tx.js";
import { statementObserve, type PreparedWrite } from "./write.js";

/** A write handle, as `batch` reads it: it can plan itself without running. */
type Op = { readonly "~plan"?: () => Promise<PreparedWrite>; readonly "~refresh"?: true };

/**
 * Runs write handles as one atomic unit.
 *
 * @param session - Client session
 * @param ops - Write handles: `insert`, `update`, `delete`, `archive`. A `restore`, a write with `expect`, or `refresh()` is OKM1121 (D183, D239)
 * @param options - `signal` and `timeout` for the whole batch
 * @param replica - Set by `.replica()`. A batch needs the primary (OKM1840)
 * @returns One result per operation, in order
 */
export async function batch(
  session: Session,
  ops: unknown,
  options: object | undefined,
  replica: true | undefined,
): Promise<readonly unknown[]> {
  try {
    if (replica !== undefined) {
      throw new OkmError(
        "OKM1840",
        "batch() needs the primary. .replica() is not allowed on a batch.",
        withHttp(session.http, {
          fix: { summary: "Remove .replica(). A batch always runs on the primary." },
        }),
      );
    }
    if (!Array.isArray(ops)) fail("OKM1121", "batch expects a list of write operations.");
    const record = options ?? {};
    if (!isRecord(record)) fail("OKM1121", "batch options must be an object.");
    rejectKeys(record, ["signal", "timeout"], "batch");
    await refuseUncancellableTimeout(
      session.pool,
      typeof record["timeout"] === "number" ? record["timeout"] : undefined,
    );
    for (const op of ops as readonly Op[]) {
      if (typeof op === "object" && op !== null && op["~refresh"] === true) {
        fail(
          "OKM1121",
          "batch does not take refresh(). Await refresh() on its own. It is one statement and cannot share the batch.",
        );
      }
    }
    const prepared: PreparedWrite[] = [];
    const list = ops as readonly Op[];
    for (let index = 0; index < list.length; index += 1) {
      const op = list[index];
      const plan = typeof op === "object" && op !== null ? op["~plan"] : undefined;
      if (plan === undefined) {
        fail(
          "OKM1121",
          "batch takes write operations: insert, update, delete, and archive. Pass them without awaiting.",
        );
      }
      let item: PreparedWrite;
      try {
        item = await plan();
      } catch (error) {
        throw stampValidation(error, index);
      }
      if (item.checked === "parent") {
        throw new OkmError(
          "OKM1705",
          "batch does not take an update that sets a path column. The parent is checked in the statement, and a batch cannot report that after it commits. Use update({ where, set }) inside tx().",
          { fix: { summary: "Use update({ where, set }) inside tx()." } },
        );
      }
      if (item.checked === "tree") {
        fail(
          "OKM1121",
          "batch does not take an update that sets a tree parent. The cycle is checked in the statement, and a batch cannot report that after it commits. Use update({ where, set }) inside tx().",
        );
      }
      if (item.checked !== undefined) {
        fail(
          "OKM1121",
          item.checked === "restore"
            ? "batch does not take restore: it is refused while its parent is archived, and a batch cannot report that after it commits. Use tx()."
            : "batch does not take a write with expect: the count is checked after the statement ran, and a batch cannot report that after it commits. Use tx().",
        );
      }
      prepared.push(item);
    }
    return await run(session, prepared, record);
  } catch (error) {
    return settleCall(session, error);
  }
}

async function run(
  session: Session,
  prepared: readonly PreparedWrite[],
  options: Record<string, unknown>,
): Promise<readonly unknown[]> {
  await session.connected;
  const statements: Statement[] = [];
  const starts: number[] = [];
  for (const item of prepared) {
    starts.push(statements.length);
    statements.push(...item.statements);
  }
  if (statements.length === 0) return prepared.map((item) => item.finish([]));
  const watching = session.o !== undefined || session.q !== undefined;
  const observe = watching
    ? prepared.flatMap((item) => statementObserve(true, item) ?? rawObserve(item))
    : undefined;
  if (session.q !== undefined && wantsQueryParams(session.q)) {
    const { rememberSecrets } = await import("./observe-query.js");
    rememberSecrets(statements, session.schema, session.scope, undefined);
  }
  let results;
  try {
    results = await runWrite(session, statements, call(options), true, observe);
  } catch (error) {
    throw at(error, starts);
  }
  const extra = await recover(session, prepared, results, starts, options);
  const decode = (): readonly unknown[] =>
    prepared.map((item, index) => {
      const from = starts[index] ?? 0;
      const slice = results.slice(from, from + item.statements.length);
      const more = extra.found.get(index);
      return item.finish(more === undefined ? slice : slice.concat(more));
    });
  if (session.q === undefined) return decode();
  const { finishObserved } = await import("./observe-query.js");
  const groups = extra.ran === undefined ? [results] : [results, extra.ran];
  return finishObserved(session, groups, decode);
}

async function recover(
  session: Session,
  prepared: readonly PreparedWrite[],
  results: readonly ExecuteResult[],
  starts: readonly number[],
  options: Record<string, unknown>,
): Promise<{
  readonly found: Map<number, readonly ExecuteResult[]>;
  readonly ran?: readonly ExecuteResult[];
}> {
  const pending: { readonly index: number; readonly statements: readonly Statement[] }[] = [];
  for (let index = 0; index < prepared.length; index += 1) {
    const item = prepared[index];
    if (item?.follow === undefined) continue;
    const from = starts[index] ?? 0;
    const more = item.follow(results.slice(from, from + item.statements.length));
    if (more.length === 0) continue;
    pending.push({ index, statements: more });
  }
  const found = new Map<number, readonly ExecuteResult[]>();
  if (pending.length === 0) return { found };
  const flat: Statement[] = [];
  const extraStarts: number[] = [];
  for (const item of pending) {
    extraStarts.push(flat.length);
    flat.push(...item.statements);
  }
  let ran: readonly ExecuteResult[];
  const watching = session.o !== undefined || session.q !== undefined;
  const observe = watching
    ? pending.flatMap((item) => {
        const base = prepared[item.index]?.observe;
        if (base === undefined) return rawStatements(item.statements);
        return item.statements.map((statement) =>
          /\breturning\b/i.test(statement.text) ? { ...base, returning: true } : base,
        );
      })
    : undefined;
  if (session.q !== undefined && wantsQueryParams(session.q)) {
    const { rememberSecrets } = await import("./observe-query.js");
    rememberSecrets(flat, session.schema, session.scope, undefined);
  }
  try {
    ran = await runWrite(session, flat, call(options), true, observe);
  } catch (error) {
    throw mapExtra(error, pending, extraStarts);
  }
  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index];
    if (item === undefined) continue;
    const from = extraStarts[index] ?? 0;
    found.set(item.index, ran.slice(from, extraStarts[index + 1] ?? ran.length));
  }
  return { found, ran };
}

function wantsQueryParams(handler: object | undefined): boolean {
  return (handler as { observeParams?: boolean } | undefined)?.observeParams === true;
}

const RAW_OBSERVE = {
  table: null,
  op: "raw" as const,
  tenant: null,
  settings: [] as readonly string[],
  source: "client" as const,
};

/**
 * Fallback metadata when a batched operation recorded none.
 *
 * @param item - Planned operation
 * @returns One raw meta per statement
 */
function rawObserve(item: PreparedWrite): (typeof RAW_OBSERVE)[] {
  return item.statements.map(() => RAW_OBSERVE);
}

/**
 * Fallback metadata for follow-up statements that have no base meta.
 *
 * @param statements - Follow-up statements
 * @returns One raw meta per statement
 */
function rawStatements(statements: readonly Statement[]): (typeof RAW_OBSERVE)[] {
  return statements.map(() => RAW_OBSERVE);
}

function mapExtra(
  error: unknown,
  pending: readonly { readonly index: number }[],
  extraStarts: readonly number[],
): unknown {
  const failed = (error as { readonly batchIndex?: unknown } | null)?.batchIndex;
  const move = (error as { readonly at?: (index: number | null) => unknown } | null)?.at;
  if (typeof failed !== "number" || typeof move !== "function") return error;
  let slot = 0;
  while (slot + 1 < extraStarts.length && (extraStarts[slot + 1] ?? Infinity) <= failed) slot += 1;
  const op = pending[slot]?.index ?? slot;
  return op === failed ? error : move.call(error, op);
}

function call(options: Record<string, unknown>): ExecuteOptions | undefined {
  const { signal, timeout } = options;
  if (signal === undefined && timeout === undefined) return undefined;
  return {
    ...(signal !== undefined ? { signal: signal as AbortSignal } : {}),
    ...(typeof timeout === "number" ? { timeout } : {}),
  };
}

/** Turns the failing statement's index into the failing operation's index. */
function at(error: unknown, starts: readonly number[]): unknown {
  const failed = (error as { readonly batchIndex?: unknown } | null)?.batchIndex;
  const move = (error as { readonly at?: (index: number | null) => unknown } | null)?.at;
  if (typeof failed !== "number" || typeof move !== "function") return error;
  let index = 0;
  while (index + 1 < starts.length && (starts[index + 1] ?? Infinity) <= failed) index += 1;
  return index === failed ? error : move.call(error, index);
}

/**
 * Attaches `batchIndex` to a validation failure that happened while planning.
 *
 * Nothing has been sent yet, so the batch has not written. The index still
 * names the operation whose rules failed.
 *
 * @param error - Thrown while planning one operation
 * @param index - That operation's place in the batch
 * @returns The same error, or OKM1200 with `batchIndex` set
 */
function stampValidation(error: unknown, index: number): unknown {
  if (!(error instanceof OkmError) || error.code !== "OKM1200" || error.batchIndex !== null) {
    return error;
  }
  return new OkmError(error.code, error.message, {
    kind: error.kind,
    retryable: error.retryable,
    fix: error.fix,
    batchIndex: index,
    fieldReason: error.fieldReason,
    ...(error.table !== undefined ? { table: error.table } : {}),
    ...(error.columns.length > 0 ? { columns: error.columns } : {}),
    ...(error.constraint !== undefined ? { constraint: error.constraint } : {}),
    ...(error.sqlstate !== undefined ? { sqlstate: error.sqlstate } : {}),
    ...(error.issues !== undefined ? { issues: error.issues } : {}),
    ...(error.cause !== undefined ? { cause: error.cause } : {}),
  });
}
