/**
 * One holder at a time for tests that pause WAL replay.
 *
 * Test files run in parallel. Pausing a replica while another file is waiting
 * for it to catch up makes that wait fail.
 */

import { openPostgres, primaryUrl } from "@okmodel/harness";

const KEY = 808001;

/**
 * Holds a session advisory lock for the duration of `fn`.
 *
 * @param fn - Work that pauses or waits on replay
 * @returns Whatever `fn` returns
 */
export async function withReplayLock<T>(fn: () => Promise<T>): Promise<T> {
  const sql = openPostgres(primaryUrl());
  await sql.unsafe("SELECT pg_advisory_lock($1)", [KEY]);
  try {
    return await fn();
  } finally {
    await sql.unsafe("SELECT pg_advisory_unlock($1)", [KEY]).catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
}
