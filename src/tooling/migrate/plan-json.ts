/**
 * Machine-readable `okm migrate plan --json` (D279).
 *
 * The document is the plan the comment renderer reads. It is not parsed
 * back out of the human SQL text.
 */

import type { MigrationClass } from "./classify.js";
import type { Finding } from "./lint.js";
import type { MigrationPlan, PlanStep } from "./plan.js";

/** One step in a plan document. `lock` matches the human `-- lock:` line. */
export type PlanStepJson = {
  readonly class: MigrationClass;
  readonly lock: string;
  readonly sql: string;
};

/** One lint finding in a plan document. */
export type PlanFindingJson = {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly place: string;
  readonly reason: string;
  readonly fix: string;
};

/**
 * Plan fields inside the `okm.cli/1` envelope `data` for `okm migrate plan --json`.
 *
 * `class` is the strictest class, the same value as the human header.
 */
export type PlanDocument = {
  readonly name: string;
  readonly class: MigrationClass;
  readonly steps: readonly PlanStepJson[];
  readonly findings: readonly PlanFindingJson[];
};

/**
 * Builds the plan document stored in envelope `data`.
 *
 * `lockText` is the same callback {@link formatPlan} uses, so a lock line
 * that includes a row estimate is the same string in both outputs.
 *
 * @param plan - Plan the command already computed
 * @param findings - Lint findings for that plan
 * @param lockText - Annotated lock, when a target answered
 * @returns The document
 */
export function planDocument(
  plan: MigrationPlan,
  findings: readonly Finding[],
  lockText?: (step: PlanStep) => string,
): PlanDocument {
  return {
    name: plan.name,
    class: plan.class,
    steps: plan.steps.map((step) => ({
      class: step.class,
      lock: lockText === undefined ? step.lock : lockText(step),
      sql: step.sql,
    })),
    findings: findings.map((finding) => ({
      severity: finding.severity,
      code: finding.code,
      place: finding.place,
      reason: finding.reason,
      fix: finding.fix,
    })),
  };
}

/**
 * Serialises a plan document.
 *
 * @param plan - Plan the command already computed
 * @param findings - Lint findings for that plan
 * @param lockText - Annotated lock, when a target answered
 * @returns JSON text ending in a newline
 */
export function formatPlanJson(
  plan: MigrationPlan,
  findings: readonly Finding[],
  lockText?: (step: PlanStep) => string,
): string {
  return `${JSON.stringify(planDocument(plan, findings, lockText))}\n`;
}

/**
 * Reads a plan document.
 *
 * Extra fields are ignored. A missing field, or a class that is not
 * `expand`, `contract`, or `unclassified`, is refused.
 *
 * @param text - JSON from `okm migrate plan --json`
 * @returns The document
 */
export function parsePlanJson(text: string): PlanDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("okm migrate plan --json did not print JSON.");
  }
  const body = planBody(parsed);
  if (!isPlanDocument(body)) {
    throw new Error("okm migrate plan --json did not print a plan document.");
  }
  return body;
}

function planBody(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.schema !== "okm.cli/1") return value;
  return value.data;
}

function isPlanDocument(value: unknown): value is PlanDocument {
  if (!isRecord(value)) return false;
  if (typeof value.name !== "string") return false;
  if (!isClass(value.class)) return false;
  if (!Array.isArray(value.steps) || !Array.isArray(value.findings)) return false;
  return value.steps.every(isStep) && value.findings.every(isFinding);
}

function isStep(value: unknown): value is PlanStepJson {
  if (!isRecord(value)) return false;
  return isClass(value.class) && typeof value.lock === "string" && typeof value.sql === "string";
}

function isFinding(value: unknown): value is PlanFindingJson {
  if (!isRecord(value)) return false;
  return (
    (value.severity === "error" || value.severity === "warning") &&
    typeof value.code === "string" &&
    typeof value.place === "string" &&
    typeof value.reason === "string" &&
    typeof value.fix === "string"
  );
}

function isClass(value: unknown): value is MigrationClass {
  return value === "expand" || value === "contract" || value === "unclassified";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
