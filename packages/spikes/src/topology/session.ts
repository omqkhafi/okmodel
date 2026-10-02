/**
 * Session watermarks.
 *
 * The root client and `unscoped()` share one watermark. `for()` has its own.
 * A watermark only moves forward. Position-unknown stays set until a later
 * position read succeeds.
 */

import { compareLsn } from "@okmodel/harness";

/** Commit position for one session. */
export type SessionMark = {
  /** Highest commit position observed. Null before the first successful read. */
  lsn: string | null;
  /** The position read after a commit failed. */
  unknown: boolean;
};

/**
 * A session that has not written.
 *
 * @returns An empty mark
 */
export function emptyMark(): SessionMark {
  return { lsn: null, unknown: false };
}

/**
 * Records a position read that succeeded.
 *
 * A lower LSN does not move the watermark backward. The unknown flag clears
 * because the read succeeded.
 *
 * @param mark - Session to update
 * @param lsn - Position returned after commit
 */
export function noteCommit(mark: SessionMark, lsn: string): void {
  mark.unknown = false;
  if (mark.lsn === null) {
    mark.lsn = lsn;
    return;
  }
  if (compareLsn(lsn, mark.lsn) > 0) mark.lsn = lsn;
}

/**
 * Marks the session position-unknown.
 *
 * The previous watermark stays. Reads use the primary until the next success.
 *
 * @param mark - Session to update
 */
export function markUnknown(mark: SessionMark): void {
  mark.unknown = true;
}
