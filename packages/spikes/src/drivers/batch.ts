/**
 * Atomic batch.
 *
 * Interactive and batch-mode adapters share this. A failure rolls the unit
 * back. A lost connection becomes `outcome_unknown` and does not send
 * `ROLLBACK`, because that would claim a result the client does not have.
 *
 * Statements run one at a time. Queuing the commit before the statements
 * finish makes `pg_terminate_backend` throw from postgres.js outside the
 * query promise (`socket.write` of null). A driver that cannot cancel installs
 * `statement_timeout` before the statements. A driver that can cancel aborts
 * the in-flight statement through the shared watch.
 */

import { DriverCallError, DriverError, isConnectionLoss, mapDriverError } from "./errors.js";
import type { Session } from "./session.js";
import { watchCall, type CallWatch } from "./sql.js";
import type { ExecuteOptions, ExecuteResult, Statement } from "./types.js";

let savepointIds = 0;

/**
 * Runs statements as one atomic unit.
 *
 * @param session - Connection to use
 * @param statements - Statements in order
 * @param options - Signal and timeout for the whole batch
 * @returns One result per statement
 */
export async function runAtomicBatch(
  session: Session,
  statements: readonly Statement[],
  options?: ExecuteOptions,
): Promise<readonly ExecuteResult[]> {
  const watch = watchCall(options);
  try {
    if (watch?.signal.aborted === true) throw callError(watch);
    if (session.inTransaction()) return await runSavepoint(session, statements, options, watch);
    return await runTransaction(session, statements, options, watch);
  } finally {
    watch?.finish();
  }
}

async function runTransaction(
  session: Session,
  statements: readonly Statement[],
  options: ExecuteOptions | undefined,
  watch: CallWatch | undefined,
): Promise<readonly ExecuteResult[]> {
  try {
    await session.begin(watch);
    if (!session.canCancel && options?.timeout !== undefined) {
      await session.query(
        {
          text: "SELECT set_config('statement_timeout', $1, true)",
          params: [String(options.timeout)],
        },
        options,
        watch,
      );
    }
    const results: ExecuteResult[] = [];
    for (let index = 0; index < statements.length; index++) {
      const statement = statements[index];
      if (statement === undefined) continue;
      try {
        results.push(await session.query(statement, options, watch));
      } catch (error) {
        throw stamp(error, index);
      }
    }
    await session.commit(watch);
    return results;
  } catch (error) {
    await rollbackUnlessLost(session, error);
    throw asBatchError(error, watch);
  }
}

async function runSavepoint(
  session: Session,
  statements: readonly Statement[],
  options: ExecuteOptions | undefined,
  watch: CallWatch | undefined,
): Promise<readonly ExecuteResult[]> {
  savepointIds += 1;
  const name = `okm_b${String(savepointIds)}`;
  try {
    await session.savepoint(name);
    const results: ExecuteResult[] = [];
    for (let index = 0; index < statements.length; index++) {
      const statement = statements[index];
      if (statement === undefined) continue;
      if (watch?.signal.aborted === true) throw callError(watch);
      try {
        results.push(await session.query(statement, options, watch));
      } catch (error) {
        throw stamp(error, index);
      }
    }
    await session.release(name);
    return results;
  } catch (error) {
    if (!isConnectionLoss(error)) {
      await session.rollbackTo(name).catch(() => undefined);
    }
    throw asBatchError(error, watch);
  }
}

async function rollbackUnlessLost(session: Session, error: unknown): Promise<void> {
  if (isConnectionLoss(error) || callKindOf(error) === "outcome_unknown") return;
  await session.rollback().catch(() => undefined);
}

function stamp(error: unknown, index: number): unknown {
  if (isConnectionLoss(error)) return new DriverCallError("outcome_unknown", error);
  if (error instanceof DriverCallError) return error;
  const mapped = mapDriverError(error, index);
  return mapped instanceof DriverError ? mapped : error;
}

function asBatchError(error: unknown, watch: CallWatch | undefined): unknown {
  if (isConnectionLoss(error)) return new DriverCallError("outcome_unknown", error);
  if (error instanceof DriverCallError && error.kind === "timeout") {
    return new DriverCallError("cancelled", error.cause, "cancelled");
  }
  if (error instanceof DriverCallError) return error;
  if (watch?.cause() === "signal") return new DriverCallError("cancelled", error);
  if (watch?.cause() === "timeout") return new DriverCallError("cancelled", error);
  const index = error instanceof DriverError ? error.batchIndex : null;
  return mapDriverError(error, index);
}

function callError(watch: CallWatch): DriverCallError {
  const cause = watch.cause();
  if (cause === "timeout") return new DriverCallError("timeout");
  return new DriverCallError("cancelled");
}

function callKindOf(error: unknown): string | undefined {
  return error instanceof DriverCallError ? error.kind : undefined;
}
