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
import type { Hookm, Timeouts } from "./types.js";

/** What a write needs from the client: a pool, the default statement timeout, and observers. */
export type RunHost = {
  readonly pool: DriverPool;
  readonly timeouts?: Timeouts | undefined;
  readonly hookm?: readonly Hookm[] | undefined;
  /** Set inside a transaction. A unit of several statements is a savepoint there, not a transaction. */
  readonly tx?: object | undefined;
};

/**
 * Runs write statements as one atomic unit.
 *
 * A call with no `timeout` takes `timeouts.statement`. Notices go to
 * `hookm.onNotice`. A unit of several statements is a transaction to
 * `hookm.onTransaction`.
 *
 * @param host - Pool, default timeout, and observers
 * @param statements - Statements in order
 * @param options - Signal and timeout for the whole unit
 * @param atomic - Use the driver's atomic `batch` even for one statement, so a failure carries `batchIndex`
 * @returns One result per statement
 */
export async function runWrite(
  host: RunHost,
  statements: readonly Statement[],
  options: ExecuteOptions | undefined,
  atomic?: true,
): Promise<readonly ExecuteResult[]> {
  if (statements.length === 0) return [];
  const first = statements[0];
  const limit = options?.timeout ?? host.timeouts?.statement;
  const call: ExecuteOptions | undefined =
    limit === undefined || limit === options?.timeout ? options : { ...options, timeout: limit };
  const single = statements.length === 1 && first !== undefined && atomic === undefined;
  const watched =
    host.hookm !== undefined && !single && host.tx === undefined
      ? await import("./hookm.js")
      : undefined;
  watched?.phase(host.hookm, "start", 0);
  let results: readonly ExecuteResult[];
  try {
    results = single
      ? [await host.pool.execute(first.text, first.params, call)]
      : await host.pool.batch(statements, call);
  } catch (error) {
    watched?.phase(host.hookm, "rollback", 0);
    throw error;
  }
  watched?.phase(host.hookm, "commit", 0);
  if (host.hookm !== undefined) {
    const heard = results.flatMap((result) => result.notices);
    if (heard.length > 0) (await import("./hookm.js")).notices(host.hookm, heard);
  }
  return results;
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
