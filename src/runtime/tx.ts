/**
 * Internal transaction runner for multi-statement writes.
 *
 * One statement uses the pool. Several statements use `batch`, which reserves
 * a connection, begins, and commits. Inside an open transaction, `batch` is a
 * savepoint and does not commit the outer transaction (D124). A connection
 * lost at commit is `outcome_unknown`. Public `tx` is P29.
 */

import type {
  DriverConnection,
  DriverPool,
  ExecuteOptions,
  ExecuteResult,
  Statement,
} from "../contracts/driver.js";

/**
 * Runs write statements as one atomic unit.
 *
 * @param pool - Endpoint pool
 * @param statements - Statements in order
 * @param options - Signal and timeout for the whole unit
 * @returns One result per statement
 */
export async function runWrite(
  pool: DriverPool,
  statements: readonly Statement[],
  options: ExecuteOptions | undefined,
): Promise<readonly ExecuteResult[]> {
  if (statements.length === 0) return [];
  const first = statements[0];
  if (statements.length === 1 && first !== undefined) {
    return [await pool.execute(first.text, first.params, options)];
  }
  return pool.batch(statements, options);
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
