import { join } from "node:path";

import type { Sql } from "postgres";

import { compareLsn } from "./lsn.js";
import { openPostgres, postgresReachable } from "./postgres.js";
import { replicaUrl, primaryUrl, type ReplicaName } from "./topology.js";

/** Session lock so two files do not pause or stop a replica at the same time. */
const REPLICATION_LOCK = 640640640;

const composeFile = join(import.meta.dir, "..", "docker", "compose.yml");
const repoRoot = join(import.meta.dir, "..", "..", "..");

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

/**
 * Holds a cluster advisory lock for the duration of `fn`.
 *
 * Streaming-replication tests share one primary. The lock keeps a pause, a
 * resume, or a stopped replica from overlapping another file.
 *
 * @param fn - Work that touches replay or a replica container
 * @returns Whatever `fn` returns
 */
export async function withReplicationLock<T>(fn: () => Promise<T>): Promise<T> {
  const sql = openPostgres(primaryUrl());
  await sql.unsafe(`select pg_advisory_lock(${String(REPLICATION_LOCK)})`);
  try {
    return await fn();
  } finally {
    await sql
      .unsafe(`select pg_advisory_unlock(${String(REPLICATION_LOCK)})`)
      .catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
}

/**
 * Stops or starts one replica container and waits until that is visible.
 *
 * Stop waits until the published port refuses connections. Start waits until
 * the server accepts connections and `pg_is_in_recovery()` is true.
 *
 * @param replica - Which replica
 * @param running - `false` stops the container, `true` starts it
 */
export async function setReplicaContainer(replica: ReplicaName, running: boolean): Promise<void> {
  const service = replica === "a" ? "replica-a" : "replica-b";
  const proc = Bun.spawn(
    ["docker", "compose", "-f", composeFile, "-p", "okmodel", running ? "start" : "stop", service],
    { cwd: repoRoot, stdout: "ignore", stderr: "pipe", env: process.env },
  );
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `docker compose ${running ? "start" : "stop"} ${service} failed: ${stderr.trim()}`,
    );
  }
  const url = replicaUrl(replica);
  if (!running) {
    await waitUntil(async () => !(await postgresReachable(url)), `replica ${replica} did not stop`);
    return;
  }
  await waitUntil(
    async () => {
      if (!(await postgresReachable(url))) return false;
      const sql = openPostgres(url);
      try {
        const rows = await sql<{ recovering: boolean }[]>`select pg_is_in_recovery() as recovering`;
        return rows[0]?.recovering === true;
      } catch {
        return false;
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
    `replica ${replica} did not start`,
    45_000,
  );
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
