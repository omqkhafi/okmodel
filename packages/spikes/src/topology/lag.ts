/**
 * Lag bounds and LSN differences.
 *
 * `maxLag` is `"5s"` or `"16MB"` in the spec. Byte lag is the primary insert
 * LSN minus the replica replay LSN. Time lag is zero when the replica has
 * caught the primary, even if its replay timestamp is old.
 */

import { compareLsn, lsnToBigInt } from "@okmodel/harness";

/** A parsed `maxLag` value. */
export type LagLimit =
  | { readonly kind: "bytes"; readonly bytes: bigint }
  | { readonly kind: "time"; readonly ms: number };

const UNIT = /^(?<amount>\d+)(?<unit>ms|s|GB|MB|KB|B)$/;

/**
 * Parses a `maxLag` string.
 *
 * @param text - `"5s"`, `"500ms"`, `"16MB"`, `"1KB"`, or `"1B"`
 * @returns The bound
 */
export function parseMaxLag(text: string): LagLimit {
  const match = UNIT.exec(text);
  const amount = match?.groups?.amount;
  const unit = match?.groups?.unit;
  if (amount === undefined || unit === undefined) {
    throw new Error(`Invalid maxLag '${text}'. Use a duration (5s, 500ms) or a size (16MB, 1B).`);
  }
  const value = BigInt(amount);
  if (unit === "ms") return { kind: "time", ms: Number(value) };
  if (unit === "s") return { kind: "time", ms: Number(value) * 1000 };
  const factor =
    unit === "GB" ? 1024n ** 3n : unit === "MB" ? 1024n ** 2n : unit === "KB" ? 1024n : 1n;
  return { kind: "bytes", bytes: value * factor };
}

/**
 * Parses a probe interval.
 *
 * @param text - `"1s"` or `"200ms"`
 * @returns Milliseconds
 */
export function parseProbe(text: string): number {
  const limit = parseMaxLag(text);
  if (limit.kind !== "time") throw new Error(`Invalid probe interval '${text}'.`);
  return limit.ms;
}

/**
 * Byte lag of a replica against the primary insert LSN.
 *
 * A replica at or ahead of the primary has lag zero.
 *
 * @param primaryLsn - Primary insert LSN, or null when it is unknown
 * @param replayLsn - Replica replay LSN, or null when it is unknown
 * @returns The gap in bytes, or null when either LSN is missing
 */
export function lagBytes(primaryLsn: string | null, replayLsn: string | null): bigint | null {
  if (primaryLsn === null || replayLsn === null) return null;
  if (compareLsn(replayLsn, primaryLsn) >= 0) return 0n;
  return lsnToBigInt(primaryLsn) - lsnToBigInt(replayLsn);
}

/**
 * Time lag in milliseconds.
 *
 * A caught-up replica (zero byte lag) has time lag zero. An idle primary does
 * not make it look stale.
 *
 * @param bytes - Byte lag from {@link lagBytes}
 * @param replayedAtMs - `pg_last_xact_replay_timestamp` as epoch milliseconds
 * @param nowMs - Clock reading
 * @returns Milliseconds behind, or null when the timestamp is missing and the replica is behind
 */
export function lagTimeMs(
  bytes: bigint | null,
  replayedAtMs: number | null,
  nowMs: number,
): number | null {
  if (bytes === null) return null;
  if (bytes === 0n) return 0;
  if (replayedAtMs === null) return null;
  return Math.max(0, nowMs - replayedAtMs);
}

/**
 * Returns whether observed lag is inside the bound.
 *
 * Unknown lag is outside the bound. A replica is not treated as eligible when
 * the bound cannot be checked.
 *
 * @param lag - Observed byte and time lag
 * @param limit - Configured bound
 * @returns True when the replica may serve
 */
export function withinLag(
  lag: { readonly bytes: bigint | null; readonly ms: number | null },
  limit: LagLimit,
): boolean {
  if (limit.kind === "bytes") {
    if (lag.bytes === null) return false;
    return lag.bytes <= limit.bytes;
  }
  if (lag.ms === null) return false;
  return lag.ms <= limit.ms;
}
