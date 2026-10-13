/**
 * Shared reset and lost-connection guard for a reserved connection.
 *
 * node-postgres, Bun.sql, and PGlite load this with the first reserve.
 * postgres.js keeps its own copy: a second module in that adapter bundle
 * crosses the incremental size gate.
 */

import { isConnectionLost } from "../../contracts/connection.js";
import { rejectClosed } from "../failure.js";

const RESET_ALL = "RESET ALL";
const UNLOCK = "SELECT pg_advisory_unlock_all()";

/** Set when the reserved socket is gone. */
export type Lost = {
  on: boolean;
};

/**
 * Clears session state on a reserved connection.
 *
 * A failed reset rolls back and tries once more. The caller supplies `run`.
 *
 * @param depth - Open transaction depth. Above zero, roll back first
 * @param run - Executes one statement on the reserved connection
 */
export async function resetSession(
  depth: number,
  run: (text: string) => Promise<unknown>,
): Promise<void> {
  if (depth > 0) await run("ROLLBACK").catch(() => undefined);
  try {
    await run(RESET_ALL);
    await run(UNLOCK);
  } catch {
    await run("ROLLBACK").catch(() => undefined);
    await run(RESET_ALL);
    await run(UNLOCK);
  }
}

/**
 * Clears a PGlite session the same way {@link resetSession} clears the others.
 *
 * Rollback goes through the session so its depth is cleared on failure too.
 *
 * @param session - The single PGlite connection
 */
export async function resetQueried(session: {
  inTransaction(): boolean;
  rollback(): Promise<void>;
  query(text: string, params: undefined, watch: undefined): Promise<unknown>;
}): Promise<void> {
  await resetSession(session.inTransaction() ? 1 : 0, (text) =>
    text === "ROLLBACK" ? session.rollback() : session.query(text, undefined, undefined),
  );
}

/**
 * Refuses the next statement after the reserved connection is gone.
 *
 * The first lost-connection error sets the flag.
 *
 * @param lost - Set when the socket is gone
 * @param run - The statement
 * @returns The statement, or a closed-pool rejection
 */
export function refuseWhenLost<T>(lost: Lost, run: () => Promise<T>): Promise<T> {
  if (lost.on) return rejectClosed();
  return run().catch((error: unknown) => {
    if (isConnectionLost(error)) lost.on = true;
    throw error;
  });
}
