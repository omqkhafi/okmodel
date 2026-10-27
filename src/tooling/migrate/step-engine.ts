/**
 * Dialect-neutral resume for one committed migration step.
 *
 * `okm_history` is the only done record. `okm_steps` exists only while a
 * committed step is in flight or broken, and it is deleted in the same
 * transaction that inserts the history row. A probe decides what a marker
 * means. The marker only says where to look.
 *
 * Transactional steps and backfills never reach this module.
 */

import { sha256 } from "../../contracts/sha256.js";
import { OkmError } from "../../contracts/error.js";
import { errorDoc } from "../errors/registry.js";

/** What a probe can say about a committed step. */
export type ProbeResult = "applied" | "absent" | "partial" | "unknown";

/** Where the statement runs relative to its history row. */
export type StepMode = "transactional" | "committed";

/** Marker states stored in `okm_steps`. */
export type MarkerState = "started" | "failed" | "retry";

/** One in-flight or broken committed step. */
export type StepMarker = {
  readonly migrationId: string;
  readonly stepIndex: number;
  readonly kind: string;
  readonly sqlHash: string;
  readonly state: MarkerState;
  readonly attempt: number;
};

/** The file's view of one committed step. */
export type CommittedStep = {
  readonly migrationId: string;
  readonly stepIndex: number;
  /** Planner kind, or `raw-sql` when the step has none. */
  readonly kind: string;
  readonly sql: string;
  /** SHA-256 of {@link stepSqlHash}. */
  readonly sqlHash: string;
  readonly stepClass: string;
  readonly catalogHash: string;
  /** True when recording this step should move `okm_meta`. */
  readonly finishes: boolean;
};

/**
 * How one dialect inspects, removes, and runs a committed step.
 *
 * `probed` is false when this kind has no probe. `probe` then returns
 * `unknown` and does not read the database.
 */
export type StepEngine = {
  readonly probed: boolean;
  /**
   * Quoted index a concurrent create builds.
   *
   * Set so a lost connection can name the INVALID index it may have left.
   */
  readonly indexLabel?: string;
  probe(): Promise<ProbeResult>;
  cleanup(): Promise<void>;
  run(): Promise<void>;
};

/** The `okm_steps` and `okm_history` writes the state machine needs. */
export type StepJournal = {
  read(migrationId: string, stepIndex: number): Promise<StepMarker | undefined>;
  /** Commits `started` with `attempt` before the statement runs. */
  start(step: CommittedStep, attempt: number): Promise<void>;
  fail(migrationId: string, stepIndex: number, code: string, errorText: string): Promise<void>;
  /** Inserts history, deletes the marker, and updates `okm_meta` when the step finishes. */
  complete(step: CommittedStep): Promise<void>;
};

/** Crash boundaries a test can stop at. A stop leaves the journal as the crash would. */
export type StepBoundary = "before-started" | "after-started" | "after-ddl";

/**
 * A failpoint stop. It is not a step failure: nothing writes `failed`.
 */
export class StepBoundaryStop extends Error {
  /** The boundary that fired. */
  readonly boundary: StepBoundary;

  /**
   * @param boundary - Where the engine stopped
   */
  constructor(boundary: StepBoundary) {
    super(`stopped at ${boundary}`);
    this.name = "StepBoundaryStop";
    this.boundary = boundary;
  }
}

/**
 * Cleanup could not remove a partial result.
 *
 * `detail` is appended to the apply error. `fix` replaces the fix text.
 * Postgres uses this for an INVALID index `DROP INDEX CONCURRENTLY` could not drop.
 */
export class PartialCleanupError extends Error {
  /** Sentence appended to the failure, including its leading space. */
  readonly detail: string;
  /** Fix shown to the operator. */
  readonly fix: string;
  /**
   * Replaces "partial index will be dropped and rebuilt" when set.
   *
   * A build that belongs to another session says to wait.
   */
  readonly next?: string;

  /**
   * @param detail - Text appended to the failure message
   * @param fix - Operator fix
   * @param cause - The drop or the still-running build
   * @param next - Line that replaces the drop-and-rebuild action
   */
  constructor(detail: string, fix: string, cause?: unknown, next?: string) {
    super(detail.trim());
    this.name = "PartialCleanupError";
    this.detail = detail;
    this.fix = fix;
    if (next !== undefined) this.next = next;
    if (cause !== undefined) this.cause = cause;
  }
}

const LOCK_BACKOFF_MS = 50;

/**
 * SHA-256 of a statement normalised to LF and trimmed.
 *
 * @param sql - Statement text
 * @returns Lowercase hex digest
 */
export function stepSqlHash(sql: string): string {
  return sha256(sql.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim());
}

/**
 * Step id `okm migrate status` prints and `okm migrate resolve` accepts.
 *
 * The index is 0-based, the same number history stores.
 *
 * @param migrationId - Migration file id
 * @param stepIndex - 0-based index in that file
 * @returns `${migrationId}:${stepIndex}`
 */
export function stepId(migrationId: string, stepIndex: number): string {
  return `${migrationId}:${String(stepIndex)}`;
}

/**
 * Mode of one unit.
 *
 * Committed means the unit is not a transaction and is not a backfill.
 * Backfill stays on its own checkpoint and is reported as transactional so
 * the engine never opens an `okm_steps` row for it.
 *
 * @param unit - One apply unit
 * @returns `committed` or `transactional`
 */
export function unitMode(unit: {
  readonly transactional: boolean;
  readonly steps: readonly { readonly step: { readonly backfill?: unknown } }[];
}): StepMode {
  if (unit.steps.some((item) => item.step.backfill !== undefined)) return "transactional";
  return unit.transactional ? "transactional" : "committed";
}

/**
 * Removes control characters and keeps the first 500 characters.
 *
 * The text is untrusted driver output. The fuller redaction pipeline is later.
 *
 * @param text - Raw failure text
 * @returns Text safe to store in `okm_steps.error_text`
 */
export function scrubErrorText(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) continue;
    out += char;
    if (out.length >= 500) break;
  }
  return out;
}

/**
 * What the next apply will do for a marker.
 *
 * @param input - 1-based step number, marker state, and the probe when one ran
 * @returns One line for status and for a failed apply
 */
export function nextApplyAction(input: {
  readonly stepNumber: number;
  readonly state: MarkerState;
  readonly probed: boolean;
  readonly probe?: ProbeResult;
}): string {
  if (input.probe === "partial") return "partial index will be dropped and rebuilt";
  if (input.probe === "unknown" && input.state !== "retry") return "needs a human";
  if (!input.probed && input.state === "retry") {
    return `resume at step ${String(input.stepNumber)}, then run`;
  }
  if (!input.probed) return "needs a human";
  return `resume at step ${String(input.stepNumber)}, probe, then run`;
}

/**
 * Failure text. The first line stays `Migration <id> failed at step N: ...`.
 *
 * @param input - Identity, the cause, and the next apply
 * @returns The message, state on the following lines
 */
export function stepFailureMessage(input: {
  readonly migrationId: string;
  readonly stepNumber: number;
  readonly kind: string;
  readonly cause: string;
  readonly probe?: ProbeResult;
  readonly next: string;
}): string {
  const probe = input.probe === undefined ? "" : ` probe ${input.probe}`;
  return [
    `Migration ${input.migrationId} failed at step ${String(input.stepNumber)}: ${input.cause}`,
    `${input.migrationId} step ${String(input.stepNumber)} kind ${input.kind}${probe}`,
    input.next,
  ].join("\n");
}

/**
 * Puts a period on the first line of a concurrent-index failure.
 *
 * The driver text (`could not create unique index "tasks_title_idx"`) is not
 * a sentence. The kind may be `raw-sql` when the step did not name one.
 *
 * @param message - The three-line failure
 * @returns The same message with the first line closed
 */
function periodOnFirstLine(message: string): string {
  const breakAt = message.indexOf("\n");
  const first = breakAt === -1 ? message : message.slice(0, breakAt);
  const rest = breakAt === -1 ? "" : message.slice(breakAt);
  return `${sentence(first)}${rest}`;
}

/**
 * Ends a failure sentence before another sentence is appended.
 *
 * @param text - Failure text
 * @returns The same text when it already ends a sentence
 */
function sentence(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return text;
  const last = trimmed.at(-1);
  if (last === "." || last === "!" || last === "?") return text;
  return `${trimmed}.`;
}

/**
 * Resumes or runs one committed step.
 *
 * No marker runs the step. `started` and `failed` follow the probe.
 * `retry` does too, except `unknown` runs the step because a human allowed it.
 * A hash that does not match the file refuses before any SQL.
 *
 * @param step - The file's step
 * @param journal - Marker and history writes
 * @param engine - Dialect probe, cleanup, and statement
 * @param options - Lock retries, an optional crash boundary, and how a driver error is wrapped
 */
export async function resumeCommittedStep(
  step: CommittedStep,
  journal: StepJournal,
  engine: StepEngine,
  options: {
    readonly retries: number;
    readonly failAt?: StepBoundary;
    readonly wrap: (error: unknown) => OkmError;
  },
): Promise<void> {
  try {
    await dispatch(step, journal, engine, options);
  } catch (error) {
    if (error instanceof StepBoundaryStop) throw error;
    if (error instanceof OkmError && (error.code === "OKM1553" || error.code === "OKM1556")) {
      throw error;
    }
    await handleRunFailure(step, journal, engine, options.wrap, error);
  }
}

async function dispatch(
  step: CommittedStep,
  journal: StepJournal,
  engine: StepEngine,
  options: {
    readonly retries: number;
    readonly failAt?: StepBoundary;
  },
): Promise<void> {
  const marker = await journal.read(step.migrationId, step.stepIndex);
  if (marker !== undefined && marker.sqlHash !== step.sqlHash) throw hashMismatch(step);
  if (marker === undefined) {
    await execute(step, journal, engine, undefined, options);
    return;
  }
  const probe = await engine.probe();
  if (marker.state === "retry" && probe === "unknown") {
    await execute(step, journal, engine, marker, options);
    return;
  }
  if (probe === "applied") {
    await withLockRetry(options.retries, () => journal.complete(step));
    return;
  }
  if (probe === "absent") {
    await execute(step, journal, engine, marker, options);
    return;
  }
  if (probe === "partial") {
    await engine.cleanup();
    await execute(step, journal, engine, marker, options);
    return;
  }
  throw needsHuman(step, probe);
}

async function execute(
  step: CommittedStep,
  journal: StepJournal,
  engine: StepEngine,
  marker: StepMarker | undefined,
  options: { readonly retries: number; readonly failAt?: StepBoundary },
): Promise<void> {
  if (options.failAt === "before-started") throw new StepBoundaryStop("before-started");
  const attempt = (marker?.attempt ?? 0) + 1;
  await withLockRetry(options.retries, () => journal.start(step, attempt));
  if (options.failAt === "after-started") throw new StepBoundaryStop("after-started");
  await withLockRetry(options.retries, () => engine.run());
  if (options.failAt === "after-ddl") throw new StepBoundaryStop("after-ddl");
  await withLockRetry(options.retries, () => journal.complete(step));
}

async function handleRunFailure(
  step: CommittedStep,
  journal: StepJournal,
  engine: StepEngine,
  wrap: (error: unknown) => OkmError,
  error: unknown,
): Promise<void> {
  let probe: ProbeResult | undefined;
  let cleanup: PartialCleanupError | undefined;
  if (engine.probed) {
    probe = await engine.probe().catch(() => "unknown" as const);
    if (probe === "applied") {
      try {
        await journal.complete(step);
        return;
      } catch (completeError) {
        error = completeError;
        probe = "applied";
      }
    } else if (probe === "partial") {
      try {
        await engine.cleanup();
        probe = "absent";
      } catch (failed) {
        if (failed instanceof PartialCleanupError) cleanup = failed;
      }
    }
  }
  const wrapped = presentFailure(step, wrap(error), probe, cleanup, engine.indexLabel);
  await journal
    .fail(step.migrationId, step.stepIndex, wrapped.code, scrubErrorText(causeOf(error)))
    .catch(() => undefined);
  throw wrapped;
}

function presentFailure(
  step: CommittedStep,
  wrapped: OkmError,
  probe: ProbeResult | undefined,
  cleanup: PartialCleanupError | undefined,
  indexLabel?: string,
): OkmError {
  const stepNumber = step.stepIndex + 1;
  const next = nextApplyAction({
    stepNumber,
    state: "failed",
    probed: probe !== undefined,
    ...(probe !== undefined ? { probe } : {}),
  });
  let message = stepFailureMessage({
    migrationId: step.migrationId,
    stepNumber,
    kind: step.kind,
    cause: stripPrefix(wrapped.message),
    ...(probe !== undefined ? { probe } : {}),
    next,
  });
  if (/^\s*create\s+(?:unique\s+)?index\s+concurrently\b/i.test(step.sql)) {
    message = periodOnFirstLine(message);
  }
  let fix = wrapped.fix;
  if (cleanup !== undefined) {
    if (cleanup.next !== undefined) {
      message = message.replaceAll("partial index will be dropped and rebuilt", cleanup.next);
    }
    const extra = cleanup.detail.trim();
    if (extra.length > 0 && !message.includes(extra)) {
      message = `${sentence(message)}${cleanup.detail}`;
    }
    fix = { summary: cleanup.fix };
  } else if (indexLabel !== undefined && wrapped.kind === "unavailable") {
    message = `${sentence(message)} Index ${indexLabel} may be INVALID.`;
    fix = {
      summary: `DROP INDEX CONCURRENTLY ${indexLabel}. Then run apply again. Finished steps are not repeated.`,
    };
  }
  return new OkmError(wrapped.code, message, {
    kind: wrapped.kind,
    cause: wrapped.cause ?? wrapped,
    fix,
    ...(wrapped.sqlstate !== undefined ? { sqlstate: wrapped.sqlstate } : {}),
  });
}

function hashMismatch(step: CommittedStep): OkmError {
  const stepNumber = step.stepIndex + 1;
  return new OkmError(
    "OKM1556",
    stepFailureMessage({
      migrationId: step.migrationId,
      stepNumber,
      kind: step.kind,
      cause: "the statement changed after the step started",
      next: "restore the statement before apply will run it",
    }),
    { fix: { summary: registryFix("OKM1556") } },
  );
}

function needsHuman(step: CommittedStep, probe: ProbeResult): OkmError {
  const stepNumber = step.stepIndex + 1;
  return new OkmError(
    "OKM1553",
    stepFailureMessage({
      migrationId: step.migrationId,
      stepNumber,
      kind: step.kind,
      cause: "the probe cannot tell whether the step is applied",
      probe,
      next: "needs a human",
    }),
    { fix: { summary: registryFix("OKM1553") } },
  );
}

function registryFix(code: string): string {
  return errorDoc(code)?.fix ?? "Inspect the step and run apply again.";
}

function stripPrefix(message: string): string {
  const match = /^Migration .+ failed at step \d+: /.exec(message);
  return match === null ? message : message.slice(match[0].length);
}

function causeOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "The step failed.";
}

function isLockTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("sqlstate" in error && error.sqlstate === "55P03") return true;
  const message = error instanceof Error ? error.message : "";
  return message.includes("lock timeout");
}

async function withLockRetry(retries: number, work: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await work();
      return;
    } catch (error) {
      if (!isLockTimeout(error) || attempt === retries) throw error;
      await delay(LOCK_BACKOFF_MS * 2 ** attempt);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
