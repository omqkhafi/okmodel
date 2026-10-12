/**
 * A session that dies in the middle of a command.
 *
 * A commit that was sent and never answered stays OKM1401. Every other
 * dropped connection is unavailable. Cleanup that throws is ignored so the
 * original failure is the one the command reports.
 */

import { isConnectionLost } from "../../contracts/connection.js";
import { OkmError } from "../../contracts/error.js";

const UNAVAILABLE_FIX = {
  summary:
    "The connection to Postgres closed. Run the command again when the database is reachable.",
};

/**
 * Maps a lost session to unavailable or OKM1401.
 *
 * An {@link OkmError} that already has one of those kinds is returned. An
 * `invalid` error whose cause is a lost session keeps its message and takes
 * that kind. Anything else returns `undefined`.
 *
 * @param error - Caught value
 * @returns The session failure, or `undefined` when this is some other error
 */
export function sessionFailure(error: unknown): OkmError | undefined {
  if (error instanceof OkmError) {
    if (error.kind === "outcome_unknown" || error.kind === "unavailable") return error;
    const cause: unknown = error.cause;
    if (cause === undefined || cause === error || error.kind !== "invalid") return undefined;
    const inner = sessionFailure(cause);
    if (inner === undefined) return undefined;
    return new OkmError(inner.code, error.message, {
      kind: inner.kind,
      cause: error,
      fix: inner.fix,
    });
  }
  if (isOutcomeUnknown(error)) {
    return new OkmError("OKM1401", "The commit outcome is unknown. The result never arrived.", {
      kind: "outcome_unknown",
      cause: error,
      fix: {
        summary:
          "Check whether the write landed before retrying. This error is never retried automatically.",
      },
    });
  }
  if (!isConnectionLost(error)) return undefined;
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : "The database is unavailable.";
  return new OkmError("unavailable", message, {
    kind: "unavailable",
    cause: error,
    fix: UNAVAILABLE_FIX,
  });
}

/**
 * Runs cleanup and ignores its failure.
 *
 * A dead session must not replace the error the command is already reporting,
 * and it must not leave the process waiting on that session.
 *
 * @param run - Close, release, or unlock
 */
export async function finishQuiet(run: () => Promise<unknown>): Promise<void> {
  await run().catch(() => undefined);
}

function isOutcomeUnknown(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && Reflect.get(error, "kind") === "outcome_unknown"
  );
}
