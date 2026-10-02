/**
 * Finds a transaction's commit record in the primary WAL.
 *
 * PostgreSQL does not return a commit LSN to the client. `pg_waldump` is the
 * check that `pg_current_wal_insert_lsn()` after commit is not earlier than
 * that record.
 */

import { lsnToBigInt } from "@okmodel/harness";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const composeFile = fileURLToPath(new URL("../../../harness/docker/compose.yml", import.meta.url));

/**
 * Byte distance from the commit record to a later LSN.
 *
 * @param later - Insert LSN read after commit
 * @param commit - LSN of the commit record
 * @returns The gap in bytes
 */
export function lsnGap(later: string, commit: string): bigint {
  return lsnToBigInt(later) - lsnToBigInt(commit);
}

/**
 * Adds bytes to an LSN so a dump range includes the record that ends there.
 *
 * @param lsn - Starting LSN
 * @param bytes - Bytes to add
 * @returns The shifted LSN
 */
export function addLsn(lsn: string, bytes: bigint): string {
  const value = lsnToBigInt(lsn) + bytes;
  const hi = (value >> 32n).toString(16).toUpperCase();
  const lo = (value & 0xffffffffn).toString(16).toUpperCase();
  return `${hi}/${lo}`;
}

/** A commit record located in the primary WAL. */
export type CommitRecord = {
  /** LSN where the commit record starts. */
  readonly lsn: string;
  /** `len (rec/tot)` record length from `pg_waldump`. */
  readonly recordBytes: number;
};

/**
 * Reads the commit record for one transaction.
 *
 * @param xid - `pg_current_xact_id()` from inside the transaction
 * @param start - WAL LSN at or before the commit record
 * @param end - WAL LSN after the commit record
 * @param dataDirectory - Primary `data_directory`
 * @returns The commit record's start LSN and length
 */
export async function findCommitLsn(
  xid: string,
  start: string,
  end: string,
  dataDirectory: string,
): Promise<CommitRecord> {
  const container = (
    await capture(["docker", "compose", "-p", "okmodel", "-f", composeFile, "ps", "-q", "primary"])
  ).trim();
  if (container === "") throw new Error("Primary container is not running.");
  const wal = join(dataDirectory, "pg_wal");
  const dump = await capture([
    "docker",
    "exec",
    container,
    "pg_waldump",
    "-p",
    wal,
    "-s",
    start,
    "-e",
    end,
  ]);
  const xid32 = String(BigInt(xid) & 0xffffffffn);
  for (const line of dump.split("\n")) {
    if (!line.includes("desc: COMMIT")) continue;
    const tx = /tx:\s+(\d+)/.exec(line);
    const lsn = /lsn:\s+([0-9A-Fa-f]+\/[0-9A-Fa-f]+)/.exec(line);
    const length = /len \(rec\/tot\):\s+(\d+)\//.exec(line);
    if (tx?.[1] === xid32 && lsn?.[1] !== undefined && length?.[1] !== undefined) {
      return { lsn: lsn[1], recordBytes: Number(length[1]) };
    }
  }
  throw new Error(`No COMMIT record for xid ${xid} between ${start} and ${end}.`);
}

async function capture(args: readonly string[]): Promise<string> {
  const proc = Bun.spawn([...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0 && !stderr.includes("invalid record length")) {
    throw new Error(`${args.join(" ")} exited ${String(code)}: ${stderr.trim()}`);
  }
  return stdout;
}
