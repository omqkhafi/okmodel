/**
 * Atomic batch for an interactive connection.
 *
 * Statements run one at a time. A failure rolls the unit back. Inside an open
 * transaction the unit is a savepoint and the outer transaction stays open
 * (D124). A timeout stays kind `timeout`. An abort stays kind `cancelled`.
 */

import type { ExecuteResult, Statement, WireValue } from "../../contracts/driver.js";
import { DriverError, mapDriverError } from "../error.js";
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
  /** Starts a transaction. */
  begin(watch: Watch | undefined): Promise<void>;
  /** Commits the open transaction. */
  commit(watch: Watch | undefined): Promise<void>;
  /** Rolls the open transaction back. */
  rollback(): Promise<void>;
  /**
   * Opens a savepoint.
   *
   * @param name - Savepoint name
   */
  savepoint(name: string): Promise<void>;
  /**
   * Releases a savepoint.
   *
   * @param name - Savepoint name
   */
  releaseSavepoint(name: string): Promise<void>;
  /**
   * Rolls back to a savepoint.
   *
   * @param name - Savepoint name
   */
  rollbackTo(name: string): Promise<void>;
};

let savepointIds = 0;

/**
 * Next transaction depth after one statement.
 *
 * `execute("BEGIN")` opens a transaction the batch must see. Only a whole
 * command matches, so `ROLLBACK TO SAVEPOINT` stays inside the transaction.
 *
 * @param depth - Depth before the statement
 * @param text - Statement text
 * @returns Depth after a successful statement
 */
export function nextTransactionDepth(depth: number, text: string): number {
  const command = text.trim().replace(/;\s*$/, "").trim().toLowerCase();
  if (command === "begin" || command === "begin work" || command === "begin transaction") {
    return depth + 1;
  }
  if (command === "commit" || command === "commit work" || command === "end") {
    return Math.max(0, depth - 1);
  }
  if (command === "rollback" || command === "rollback work") return 0;
  return depth;
}

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
    await session.begin(watch);
    const results = await statementsOf(session, statements, watch);
    try {
      await session.commit(watch);
    } catch (error) {
      throw stamp(error, null);
    }
    return results;
  } catch (error) {
    await session.rollback().catch(() => undefined);
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
    await session.savepoint(name);
    const results = await statementsOf(session, statements, watch);
    await session.releaseSavepoint(name);
    return results;
  } catch (error) {
    await session.rollbackTo(name).catch(() => undefined);
    throw error;
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
