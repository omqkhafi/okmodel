import type { Sql } from "postgres";

import { compareLsn } from "./lsn.js";
import { openPostgres } from "./postgres.js";
import { replicaUrl, primaryUrl, type ReplicaName } from "./topology.js";

/**
 * Reads `pg_current_wal_insert_lsn()` on the primary.
 *
 * @param sql - An open primary connection. A short-lived one is used when omitted
 * @returns The insert LSN
 */
export async function readInsertLsn(sql?: Sql): Promise<string> {
  if (sql !== undefined) return readLsn(sql, "select pg_current_wal_insert_lsn()::text as lsn");
  return withPrimary((connection) =>
    readLsn(connection, "select pg_current_wal_insert_lsn()::text as lsn"),
  );
}

/**
 * Reads `pg_last_wal_replay_lsn()` on a replica.
 *
 * @param replica - Which replica
 * @returns The replay LSN
 */
export async function readReplayLsn(replica: ReplicaName): Promise<string> {
  return withReplica(replica, (sql) =>
    readLsn(sql, "select pg_last_wal_replay_lsn()::text as lsn"),
  );
}

/**
 * Pauses WAL replay on a replica (`pg_wal_replay_pause`).
 *
 * Returns once `pg_is_wal_replay_paused()` is true.
 *
 * @param replica - Which replica
 */
export async function pauseWalReplay(replica: ReplicaName): Promise<void> {
  await withReplica(replica, async (sql) => {
    await sql`select pg_wal_replay_pause()`;
    await waitUntil(async () => {
      const rows = await sql<{ paused: boolean }[]>`select pg_is_wal_replay_paused() as paused`;
      return rows[0]?.paused === true;
    }, `replay on replica ${replica} did not pause`);
  });
}

/**
 * Resumes WAL replay on a replica (`pg_wal_replay_resume`).
 *
 * Does nothing when replay is already running.
 *
 * @param replica - Which replica
 */
export async function resumeWalReplay(replica: ReplicaName): Promise<void> {
  await withReplica(replica, async (sql) => {
    const rows = await sql<{ paused: boolean }[]>`select pg_is_wal_replay_paused() as paused`;
    if (rows[0]?.paused === true) await sql`select pg_wal_replay_resume()`;
  });
}

/**
 * Polls a replica until its replay LSN reaches `target`.
 *
 * @param replica - Which replica
 * @param target - Insert LSN the replica must catch
 * @param timeoutMs - How long to poll. Defaults to 20 seconds
 * @returns The replay LSN that satisfied the wait
 */
export async function waitForReplayLsn(
  replica: ReplicaName,
  target: string,
  timeoutMs = 20_000,
): Promise<string> {
  return withReplica(replica, async (sql) => {
    let latest = "";
    await waitUntil(
      async () => {
        const rows = await sql<
          { lsn: string | null }[]
        >`select pg_last_wal_replay_lsn()::text as lsn`;
        const lsn = rows[0]?.lsn;
        if (lsn === null || lsn === undefined || lsn === "") return false;
        latest = lsn;
        return compareLsn(lsn, target) >= 0;
      },
      `replica ${replica} replay LSN did not reach ${target} (last ${latest === "" ? "null" : latest})`,
      timeoutMs,
    );
    return latest;
  });
}

async function readLsn(sql: Sql, query: string): Promise<string> {
  const rows = await sql.unsafe<{ lsn: string | null }[]>(query);
  const lsn = rows[0]?.lsn;
  if (lsn === null || lsn === undefined || lsn === "") {
    throw new Error(`Query did not return an LSN: ${query}`);
  }
  return lsn;
}

async function withPrimary<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = openPostgres(primaryUrl());
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function withReplica<T>(replica: ReplicaName, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = openPostgres(replicaUrl(replica));
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(50);
  }
  throw new Error(message);
}

/** Gap between probes. The caller already awaits the condition itself. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
