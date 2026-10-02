/**
 * Per-target session advisory lock.
 *
 * A second apply on the same target fails at once with OKM1522. It does not
 * wait. The lock is held on the direct connection for the whole run.
 */

import type { DriverConnection } from "../drivers/types.js";
import { TargetError } from "./error.js";

/**
 * Lock key for one target name.
 *
 * @param targetName - Logical target name
 * @returns The text passed to `hashtextextended`
 */
export function advisoryLockKey(targetName: string): string {
  return `okm-target:${targetName}`;
}

/**
 * Takes the session lock or throws OKM1522.
 *
 * @param connection - Direct connection that will run the apply
 * @param targetName - Logical target name
 */
export async function acquireTargetLock(
  connection: DriverConnection,
  targetName: string,
): Promise<void> {
  const locked = await lockedFlag(
    connection,
    "select pg_try_advisory_lock(hashtextextended($1, 0))",
    targetName,
  );
  if (!locked) {
    throw new TargetError(
      "OKM1522",
      `Target ${targetName} is already being applied. The second apply stops immediately.`,
    );
  }
}

/**
 * Releases the session lock. A dead connection has already dropped it.
 *
 * @param connection - The connection that acquired the lock
 * @param targetName - Logical target name
 */
export async function releaseTargetLock(
  connection: DriverConnection,
  targetName: string,
): Promise<void> {
  await connection.execute("select pg_advisory_unlock(hashtextextended($1, 0))", [
    advisoryLockKey(targetName),
  ]);
}

async function lockedFlag(
  connection: DriverConnection,
  sql: string,
  targetName: string,
): Promise<boolean> {
  const result = await connection.execute(sql, [advisoryLockKey(targetName)]);
  const value = result.rows[0]?.[0];
  return value === "t" || value === "true";
}
