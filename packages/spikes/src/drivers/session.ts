/**
 * The session a batch runner drives.
 *
 * Adapters implement this. The runner does not know which driver it is.
 */

import type { DriverCallError } from "./errors.js";
import type { CallWatch } from "./sql.js";
import type { ExecuteOptions, ExecuteResult, Statement } from "./types.js";

/** One connection the batch runner can use. */
export type Session = {
  /** True when `AbortSignal` can stop a statement that has already started. */
  readonly canCancel: boolean;
  /**
   * Runs one statement.
   *
   * @param statement - SQL and wire parameters
   * @param options - Per-call options
   * @param watch - Shared deadline for a batch
   * @returns The statement result
   */
  query(statement: Statement, options?: ExecuteOptions, watch?: CallWatch): Promise<ExecuteResult>;
  /** Starts a transaction. */
  begin(watch?: CallWatch): Promise<void>;
  /** Commits the open transaction. */
  commit(watch?: CallWatch): Promise<void>;
  /** Rolls the open transaction back. */
  rollback(): Promise<void>;
  /**
   * Opens a savepoint.
   *
   * @param name - Savepoint identifier
   */
  savepoint(name: string): Promise<void>;
  /**
   * Releases a savepoint.
   *
   * @param name - Savepoint identifier
   */
  release(name: string): Promise<void>;
  /**
   * Rolls back to a savepoint. The transaction stays open.
   *
   * @param name - Savepoint identifier
   */
  rollbackTo(name: string): Promise<void>;
  /** True after `begin` until `commit` or `rollback`. */
  inTransaction(): boolean;
  /** Cancels every statement this session has in flight. */
  cancel(): void;
};

/**
 * Reads a call-error kind, if this error is one.
 *
 * @param error - Caught value
 * @returns The kind, or undefined
 */
export function callKind(error: unknown): DriverCallError["kind"] | undefined {
  if (typeof error !== "object" || error === null || !("kind" in error)) return undefined;
  const kind = Reflect.get(error, "kind");
  if (kind === "cancelled" || kind === "timeout" || kind === "outcome_unknown") return kind;
  return undefined;
}
