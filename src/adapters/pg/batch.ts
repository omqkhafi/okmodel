/**
 * Atomic batch for an interactive connection.
 *
 * Statements run one at a time. A failure rolls the unit back. Inside an open
 * transaction the unit is a savepoint and the outer transaction stays open
 * (D124). A timeout stays kind `timeout`. An abort stays kind `cancelled`.
 */

import { isConnectionLost } from "../../contracts/connection.js";
import type { ExecuteResult, Statement, WireValue } from "../../contracts/driver.js";
import { DriverError, mapDriverError, outcomeUnknown } from "../error.js";
import type { Watch } from "./call.js";

/** A connection that can run the batch protocol. */
export type BatchSession = {
  /** This driver can abort an in-flight statement. */
  readonly canCancel: boolean;
  /**
   * Runs one statement.
   *
   * @param text - SQL
   * @param params - Wire parameters
   * @param watch - Shared deadline for the batch, when there is one
   * @returns The statement result
   */
  query(
    text: string,
    params: readonly WireValue[] | undefined,
    watch: Watch | undefined,
  ): Promise<ExecuteResult>;
  /** Reports whether a transaction is open on this connection. */
  inTransaction(): boolean;
  /** Forgets a transaction after a rollback that did not complete. */
  abandon(): void;
};

let savepointIds = 0;

/**
 * Runs statements as one atomic unit.
 *
 * @param session - Connection to use
 * @param statements - Statements in order
 * @param watch - Deadline for the whole batch
 * @returns One result per statement
 */
export async function runAtomicBatch(
  session: BatchSession,
  statements: readonly Statement[],
  watch: Watch | undefined,
): Promise<readonly ExecuteResult[]> {
  if (session.inTransaction()) return savepoint(session, statements, watch);
  return transaction(session, statements, watch);
}

async function transaction(
  session: BatchSession,
  statements: readonly Statement[],
  watch: Watch | undefined,
): Promise<readonly ExecuteResult[]> {
  try {
    await control(session, "BEGIN", watch);
    const results = await statementsOf(session, statements, watch);
    try {
      await control(session, "COMMIT", watch);
    } catch (error) {
      if (isConnectionLost(error)) throw outcomeUnknown(error);
      throw stamp(error, null);
    }
    return results;
  } catch (error) {
    // A connection that went away has no transaction to roll back, and a write to it can crash the driver.
    if (!isConnectionLost(error)) await rollback(session);
    throw error;
  }
}

async function savepoint(
  session: BatchSession,
  statements: readonly Statement[],
  watch: Watch | undefined,
): Promise<readonly ExecuteResult[]> {
  savepointIds += 1;
  const name = `okm_b${String(savepointIds)}`;
  try {
    await control(session, `SAVEPOINT ${name}`, watch);
    const results = await statementsOf(session, statements, watch);
    await control(session, `RELEASE SAVEPOINT ${name}`, watch);
    return results;
  } catch (error) {
    if (!isConnectionLost(error)) await rollback(session, `ROLLBACK TO SAVEPOINT ${name}`);
    throw error;
  }
}

function control(session: BatchSession, text: string, watch: Watch | undefined): Promise<void> {
  return session.query(text, undefined, watch).then(() => undefined);
}

async function rollback(session: BatchSession, text = "ROLLBACK"): Promise<void> {
  try {
    await session.query(text, undefined, undefined);
  } catch {
    session.abandon();
  }
}

async function statementsOf(
  session: BatchSession,
  statements: readonly Statement[],
  watch: Watch | undefined,
): Promise<ExecuteResult[]> {
  const results = Array.from<ExecuteResult>({ length: statements.length });
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (statement === undefined) continue;
    try {
      results[index] = await session.query(statement.text, statement.params, watch);
    } catch (error) {
      throw stamp(error, index);
    }
  }
  return results;
}

function stamp(error: unknown, batchIndex: number | null): unknown {
  const mapped = mapDriverError(error, batchIndex);
  if (mapped instanceof DriverError) return mapped;
  return error;
}
