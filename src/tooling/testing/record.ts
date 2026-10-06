/**
 * A pool that records every statement sent to the driver.
 *
 * `expectQueries` counts this log. Transaction control is left out (D199).
 * The runtime logger records errors only, and `hookm` records notices and
 * transaction phases, not statement text, so the count wraps the pool.
 */

import type {
  DriverConnection,
  DriverPool,
  ExecuteOptions,
  ExecuteResult,
  Statement,
  WireValue,
} from "../../contracts/driver.js";

/** One statement that reached the driver. */
export type Recorded = {
  readonly text: string;
  readonly params: readonly WireValue[];
};

/** A recording pool and its log. */
export type Recording = {
  readonly pool: DriverPool;
  /** Every statement since the pool was wrapped, in the order sent. */
  readonly log: Recorded[];
};

/**
 * Reports whether `text` only frames a transaction.
 *
 * Not counted: `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ROLLBACK`,
 * `ROLLBACK TO`, `SAVEPOINT`, `RELEASE SAVEPOINT`, `SET TRANSACTION`,
 * `SET LOCAL`, and `SET SESSION CHARACTERISTICS`. A data statement is counted,
 * including one that runs inside a transaction.
 *
 * @param text - Statement text
 * @returns Whether the statement is transaction control
 */
export function isTransactionControl(text: string): boolean {
  const command = text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim()
    .replace(/;\s*$/, "")
    .trim()
    .toLowerCase();
  if (/^(?:begin|start\s+transaction)(?:\s|$)/.test(command)) return true;
  if (command === "commit" || command === "commit work" || command === "end") return true;
  if (command === "rollback" || command === "rollback work") return true;
  if (command.startsWith("rollback to")) return true;
  if (command.startsWith("savepoint ") || command === "savepoint") return true;
  if (command.startsWith("release savepoint ") || command.startsWith("release ")) return true;
  if (/^set\s+transaction\b/.test(command)) return true;
  if (/^set\s+local\b/.test(command)) return true;
  if (/^set\s+session\s+characteristics\b/.test(command)) return true;
  return false;
}

/**
 * Wraps a pool so each statement is logged.
 *
 * @param pool - The real pool
 * @returns The wrapped pool and its log
 */
export function record(pool: DriverPool): Recording {
  const log: Recorded[] = [];
  const note = (statement: Statement): void => {
    log.push({ text: statement.text, params: statement.params ?? [] });
  };
  const wrapConnection = (connection: DriverConnection): DriverConnection => ({
    ...connection,
    execute(text: string, params?: readonly WireValue[], options?: ExecuteOptions) {
      note({ text, ...(params !== undefined ? { params } : {}) });
      return connection.execute(text, params, options);
    },
    batch(statements: readonly Statement[], options?: ExecuteOptions) {
      for (const statement of statements) note(statement);
      return connection.batch(statements, options);
    },
    release: () => connection.release(),
    ...(connection.cancel !== undefined ? { cancel: () => connection.cancel?.() } : {}),
  });
  const wrapped: DriverPool = {
    capabilities: pool.capabilities,
    execute(
      text: string,
      params?: readonly WireValue[],
      options?: ExecuteOptions,
    ): Promise<ExecuteResult> {
      note({ text, ...(params !== undefined ? { params } : {}) });
      return pool.execute(text, params, options);
    },
    batch(statements: readonly Statement[], options?: ExecuteOptions) {
      for (const statement of statements) note(statement);
      return pool.batch(statements, options);
    },
    stats: () => pool.stats(),
    close: () => pool.close(),
    ...(pool.reserve !== undefined
      ? { reserve: async () => wrapConnection(await pool.reserve!()) }
      : {}),
    ...(pool.describe !== undefined
      ? { describe: (text: string, params?: readonly WireValue[]) => pool.describe!(text, params) }
      : {}),
    ...(pool.cancel !== undefined ? { cancel: () => pool.cancel?.() } : {}),
  };
  return { pool: wrapped, log };
}
