/**
 * Programmatic `plan`, `apply`, and `status` (D298).
 *
 * Same behaviour as `okm migrate plan`, `apply`, and `status`. Nothing here
 * exits the process, prompts, or reads stdin.
 */

import type { MigrationClass } from "./plan.js";
import type { Finding } from "./lint.js";
import { projectContext, type ProjectContext } from "./paths.js";
import { planProject } from "./project.js";
import { statusProjectRows, type CompatibilityState } from "./status.js";
import type { InvokeFlags } from "./policy.js";

/**
 * Options shared by {@link plan}, {@link apply}, and {@link status}.
 *
 * `cwd` is the process working directory when omitted. `config` is a path
 * relative to `cwd` or absolute, the same as `--config`.
 */
export type MigrateOptions = {
  /** Project directory. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Config file. Defaults to `okmodel.config.ts` in `cwd`. */
  readonly config?: string;
  /** Target name. Required when several targets are configured. */
  readonly target?: string;
  /** Same as `--allow-protected`. */
  readonly allowProtected?: boolean;
  /** Same as `--allow-pooler`. */
  readonly allowPooler?: boolean;
  /** Same as `--lock-timeout`. */
  readonly lockTimeoutMs?: number;
  /** Same as `--statement-timeout`. */
  readonly statementTimeoutMs?: number;
};

/** Options for {@link plan}. */
export type PlanOptions = MigrateOptions & {
  /** Same as repeated `--replace` values. */
  readonly replace?: readonly string[];
};

/** Options for {@link apply}. */
export type ApplyOptions = MigrateOptions & {
  /**
   * Receives each backfill progress line, including the trailing newline.
   * Absent in CI and deploy callers that only need the summary.
   */
  readonly onProgress?: (text: string) => void;
};

/** One planned step. `id` is stable (`${name}:${index}`). */
export type PlanStepResult = {
  readonly id: string;
  readonly class: MigrationClass;
  readonly sql: string;
  readonly lint: readonly Finding[];
};

/** What {@link plan} returns. */
export type PlanResult = {
  readonly name: string;
  readonly class: MigrationClass;
  readonly steps: readonly PlanStepResult[];
  readonly lint: readonly Finding[];
  /** The same text `okm migrate plan` prints, before findings. */
  readonly text: string;
  /** Plan document. `okm migrate plan --json` prints it as envelope `data`. */
  readonly json: string;
};

/** What {@link apply} returns. */
export type ApplyResult = {
  readonly target: string;
  readonly applied: readonly string[];
  /** The same text `okm migrate apply` prints. */
  readonly text: string;
};

/** What {@link status} returns for one target. */
export type StatusResult = {
  readonly target: string;
  readonly compatibility: CompatibilityState;
  /** Stable pending step ids (`${migrationId}:${stepIndex}`). */
  readonly pending: readonly string[];
  /** The same text `okm migrate status` prints for the selected targets. */
  readonly text: string;
};

/**
 * Plans the current schema against the latest snapshot.
 *
 * @param name - Plan name, the same positional `okm migrate plan` takes
 * @param options - Config path, target, replace values, and protection flags
 * @returns Serialisable steps plus the CLI text
 */
export async function plan(name: string, options: PlanOptions = {}): Promise<PlanResult> {
  const planned = await planProject(
    contextOf(options),
    name,
    options.replace ?? [],
    invokeOf(options),
  );
  return {
    name: planned.plan.name,
    class: planned.plan.class,
    steps: planned.plan.steps.map((step, index) => ({
      id: `${planned.plan.name}:${String(index)}`,
      class: step.class,
      sql: step.sql,
      lint: findingsAt(planned.findings, index + 1),
    })),
    lint: planned.findings,
    text: planned.text,
    json: planned.json,
  };
}

/**
 * Applies pending migrations on the selected target.
 *
 * A failed step throws the same `OkmError` the CLI prints. A later call
 * resumes from the history checkpoints.
 *
 * @param options - Config path, target, protection, pooler, timeouts, and progress
 * @returns Applied migration ids and the CLI text
 */
export async function apply(options: ApplyOptions = {}): Promise<ApplyResult> {
  const { applyProjectResult } = await import("./apply.js");
  const { report, text } = await applyProjectResult(
    contextOf(options),
    invokeOf(options),
    options.onProgress,
  );
  return { target: report.target, applied: report.applied, text };
}

/**
 * Reads compatibility for the selected target, or every target when none is named.
 *
 * @param options - Config path and optional target
 * @returns One result per target. `text` is the full CLI table
 */
export async function status(options: MigrateOptions = {}): Promise<readonly StatusResult[]> {
  const { formatStatus } = await import("./status.js");
  const rows = await statusProjectRows(contextOf(options), invokeOf(options));
  const text = formatStatus(rows);
  return rows.map((row) => ({
    target: row.target,
    compatibility: row.compatibility,
    pending: row.pending,
    text,
  }));
}

function contextOf(options: MigrateOptions): ProjectContext {
  return projectContext(options.cwd ?? process.cwd(), options.config);
}

function invokeOf(options: MigrateOptions): InvokeFlags {
  return {
    ...(options.target !== undefined ? { target: options.target } : {}),
    allowProtected: options.allowProtected === true,
    allowPooler: options.allowPooler === true,
    ...(options.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
    ...(options.statementTimeoutMs !== undefined
      ? { statementTimeoutMs: options.statementTimeoutMs }
      : {}),
  };
}

function findingsAt(findings: readonly Finding[], step: number): readonly Finding[] {
  const prefix = `step ${String(step)}`;
  return findings.filter(
    (finding) => finding.place === prefix || finding.place.startsWith(`${prefix} `),
  );
}
