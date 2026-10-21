/**
 * Process exit codes for `okm` (contract `okm.cli/1`).
 *
 * One function maps an outcome to a code. Error codes map onto those
 * outcomes. A code with no entry is a failed run (exit 1).
 */

import { OkmError, type ErrorKind } from "../../contracts/error.js";
import type {
  CliErrorLocation,
  CliEscapeHatch,
  CliFixEdit,
  CliSafeAlternative,
} from "../errors/shape.js";
import { sessionFailure } from "../migrate/lost.js";

/** Exit codes the contract assigns. */
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5;

/** Why a run stopped, before the numeric code. */
export type CliOutcomeName = "done" | "failed" | "usage" | "decision" | "guard" | "unreachable";

const OUTCOME = Symbol.for("okm.cli.outcome");
const PARTIAL = Symbol.for("okm.cli.partial");

/**
 * Codes that are not exit 1.
 *
 * Anything absent, including a future OKM code, stays 1. `invalid` and
 * `unavailable` are kind names used as `OkmError.code` when spec §21 does
 * not number the failure. `unavailable` is exit 5. `invalid` stays 1 unless
 * the throw site tags a narrower outcome.
 */
const CODE_EXIT: Readonly<Record<string, ExitCode>> = {
  OKM1201: 2,
  OKM1530: 3,
  OKM1553: 3,
  OKM1555: 3,
  OKM1802: 5,
  OKM1803: 5,
  OKM1811: 5,
  OKM1812: 5,
  OKM1843: 5,
  OKM1844: 5,
  OKM1845: 2,
  OKM1846: 5,
  OKM1850: 4,
  OKM1852: 4,
  OKM1853: 2,
  OKM1854: 5,
  OKM1855: 4,
  OKM1856: 2,
  OKM1859: 4,
  OKM1860: 5,
  OKM1862: 4,
  OKM1863: 3,
  OKM1864: 4,
  OKM1865: 5,
  OKM1866: 4,
  OKM1867: 3,
  unavailable: 5,
};

/**
 * Exit code for one registry or kind code, ignoring a tagged outcome.
 *
 * @param code - `OkmError.code`
 * @returns The mapped code, or 1
 */
export function exitCodeForCode(code: string): ExitCode {
  return CODE_EXIT[code] ?? 1;
}

/**
 * Marks an error with an outcome the code map does not express.
 *
 * Parse errors are `usage` even when the code is `invalid` or OKM1541.
 * A pooler refusal is `unreachable`. Overwriting a file the user has is
 * `guard`. The property is not enumerable.
 *
 * @param error - Error about to be thrown
 * @param outcome - Outcome to report
 * @returns The same error
 */
export function tagOutcome<T extends object>(error: T, outcome: CliOutcomeName): T {
  Object.defineProperty(error, OUTCOME, { value: outcome, enumerable: false });
  return error;
}

/**
 * Outcome recorded by {@link tagOutcome}, when one was recorded.
 *
 * @param error - Caught value
 * @returns The tag, or `undefined`
 */
export function readOutcome(error: object): CliOutcomeName | undefined {
  const value: unknown = Reflect.get(error, OUTCOME);
  if (
    value === "done" ||
    value === "failed" ||
    value === "usage" ||
    value === "decision" ||
    value === "guard" ||
    value === "unreachable"
  ) {
    return value;
  }
  return undefined;
}

/** Data a command produced before it failed. The envelope still carries it. */
export type CliPartial = {
  readonly data: unknown;
  readonly warnings: readonly CliWarningBody[];
  readonly target?: CliTargetBody;
  readonly outFile: CliOutFile | null;
};

/** `level` on a warning (OKM2xxx) or a hint (OKM3xxx). */
export type CliNoticeLevel = "hint" | "warn";

/** How serious a warning or a hint is. */
export type CliNoticeSeverity = "low" | "medium" | "high";

/**
 * Warning object stored on a partial result.
 *
 * The original fields stay first. The error-object fields and `level` /
 * `severity` are additive.
 */
export type CliWarningBody = {
  readonly code?: string;
  readonly summary: string;
  readonly place?: string;
  readonly fix?: string;
  readonly location?: CliErrorLocation;
  readonly fixEdit?: CliFixEdit;
  readonly safeAlternatives?: readonly CliSafeAlternative[];
  readonly docs?: string;
  readonly escapeHatches?: readonly CliEscapeHatch[];
  readonly level?: CliNoticeLevel;
  readonly severity?: CliNoticeSeverity;
};

/** Target object stored on a partial result. */
export type CliTargetBody = {
  readonly name: string;
  readonly protected: boolean;
  readonly fingerprint: {
    readonly hostDb: string;
    readonly identity: string | null;
  };
};

/** `outFile` object stored on a partial result. */
export type CliOutFile = {
  readonly path: string;
  readonly bytes: number;
};

/**
 * Remembers JSON `data` that was ready when the command failed.
 *
 * @param error - Error about to be thrown
 * @param partial - Envelope fields already known
 * @returns The same error
 */
export function attachPartial(error: OkmError, partial: CliPartial): OkmError {
  Object.defineProperty(error, PARTIAL, { value: partial, enumerable: false });
  return error;
}

/**
 * Partial envelope fields attached with {@link attachPartial}.
 *
 * @param error - Caught value
 * @returns The partial, or `undefined`
 */
export function readPartial(error: unknown): CliPartial | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value: unknown = Reflect.get(error, PARTIAL);
  if (typeof value !== "object" || value === null) return undefined;
  if (!("data" in value) || !("warnings" in value) || !("outFile" in value)) return undefined;
  return value as CliPartial;
}

/**
 * Outcome for a thrown value.
 *
 * A tag wins over the code map. Connection loss is `unreachable` via
 * {@link sessionFailure}. The planner never prompts, so OKM1530 is always
 * `decision`.
 *
 * @param error - Caught value
 * @returns The outcome
 */
export function outcomeOf(error: unknown): CliOutcomeName {
  const mapped = sessionFailure(error) ?? OkmError.from(error);
  const tagged = readOutcome(mapped) ?? readOutcomeSafe(error);
  if (tagged !== undefined && tagged !== "done") return tagged;
  return outcomeForCode(mapped.code, mapped.kind);
}

function readOutcomeSafe(error: unknown): CliOutcomeName | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return readOutcome(error);
}

function outcomeForCode(code: string, kind: ErrorKind): CliOutcomeName {
  if (kind === "unavailable" || code === "unavailable") return "unreachable";
  switch (exitCodeForCode(code)) {
    case 0:
      return "done";
    case 2:
      return "usage";
    case 3:
      return "decision";
    case 4:
      return "guard";
    case 5:
      return "unreachable";
    default:
      return "failed";
  }
}

/**
 * Maps an outcome to the process exit code.
 *
 * @param outcome - Why the run stopped
 * @returns 0 done, 1 failed, 2 usage, 3 decision, 4 guard, 5 unreachable
 */
export function exitCodeForOutcome(outcome: CliOutcomeName): ExitCode {
  switch (outcome) {
    case "done":
      return 0;
    case "failed":
      return 1;
    case "usage":
      return 2;
    case "decision":
      return 3;
    case "guard":
      return 4;
    case "unreachable":
      return 5;
  }
}

/**
 * Exit code for a thrown value.
 *
 * @param error - Caught value
 * @returns The process exit code
 */
export function exitCodeFor(error: unknown): ExitCode {
  return exitCodeForOutcome(outcomeOf(error));
}

/**
 * A JSON run that already wrote its envelope.
 *
 * The bin sets {@link exitCode} and may write {@link stderr}. It does not
 * print a second error.
 */
export class CommandFinished extends Error {
  /** Process exit code. */
  readonly exitCode: ExitCode;
  /** One terse stderr line, or `""` when stderr must stay empty. */
  readonly stderr: string;

  /**
   * @param exitCode - Code the process will exit with
   * @param stderr - Terse line, including the newline when non-empty
   */
  constructor(exitCode: ExitCode, stderr: string) {
    super("okm command finished");
    this.name = "CommandFinished";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}
