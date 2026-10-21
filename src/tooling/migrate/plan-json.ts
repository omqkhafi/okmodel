/**
 * Machine-readable `okm migrate plan --json` (D279).
 *
 * The document is the plan the comment renderer reads. It is not parsed
 * back out of the human SQL text.
 */

import { canonicalHash } from "../canonical-json.js";
import { checkedOrUntrusted, untrustedText, type UntrustedText } from "../untrusted.js";
import {
  operationClassOf,
  strictestOperation,
  type MigrationClass,
  type OperationClass,
  type StepKind,
} from "./classify.js";
import type { Finding } from "./lint.js";
import type { MigrationPlan, PlanStep } from "./plan.js";

/** One step in a plan document. `lock` matches the human `-- lock:` line. */
export type PlanStepJson = {
  readonly class: MigrationClass;
  readonly operationClass: OperationClass;
  readonly lock: string;
  readonly sql: string;
  /**
   * Declared `-- probe:` text.
   *
   * Absent when the step has no probe. Not part of `planHash`.
   */
  readonly probe?: string;
};

/** One destructive step in a plan document. */
export type DestructiveOperation = {
  readonly stepIndex: number;
  readonly kind: StepKind;
  readonly objectKind: string;
  readonly name: string | UntrustedText;
  readonly summary: string;
};

/** Catalog hashes the plan hash commits to. Target and version are absent. */
export type PlanIdentity = {
  readonly dialect: string;
  readonly fromCatalogHash: string;
  readonly toCatalogHash: string;
};

/** One lint finding in a plan document. */
export type PlanFindingJson = {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly place: string;
  readonly reason: string | UntrustedText;
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
  readonly operationClass: OperationClass;
  readonly fromCatalogHash: string;
  readonly toCatalogHash: string;
  readonly planHash: string;
  readonly requiresAck: boolean;
  readonly steps: readonly PlanStepJson[];
  readonly destructiveOperations: readonly DestructiveOperation[];
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
  identity?: PlanIdentity,
): PlanDocument {
  const dialect = identity?.dialect ?? "postgres";
  const fromCatalogHash = identity?.fromCatalogHash ?? "";
  const toCatalogHash = identity?.toCatalogHash ?? "";
  const steps = plan.steps.map((step) => {
    const kind = step.kind ?? "raw-sql";
    return {
      class: step.class,
      operationClass: operationClassOf(kind),
      lock: lockText === undefined ? step.lock : lockText(step),
      sql: step.sql,
      kind,
      name: nameOf(step),
      ...(step.probe !== undefined && step.probe.length > 0 ? { probe: step.probe } : {}),
    };
  });
  const operationClass = strictestOperation(steps.map((step) => step.operationClass));
  const destructive = steps.flatMap((step, stepIndex) =>
    step.operationClass === "destructive"
      ? [
          {
            stepIndex,
            kind: step.kind,
            objectKind: objectKindOf(step.kind),
            name: step.name,
            summary: `The step is ${step.kind}.`,
          },
        ]
      : [],
  );
  return {
    name: plan.name,
    class: plan.class,
    operationClass,
    fromCatalogHash,
    toCatalogHash,
    planHash: canonicalHash({
      planFormat: 1,
      dialect,
      fromCatalogHash,
      toCatalogHash,
      steps: steps.map((step) => ({
        sql: step.sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
        class: step.operationClass,
      })),
    }),
    requiresAck: operationClass === "destructive",
    steps: steps.map((step) => ({
      class: step.class,
      operationClass: step.operationClass,
      lock: step.lock,
      sql: step.sql,
      ...(step.probe !== undefined ? { probe: step.probe } : {}),
    })),
    destructiveOperations: destructive,
    findings: findings.map((finding) => ({
      severity: finding.severity,
      code: finding.code,
      place: finding.place,
      reason: untrustedText(finding.reason, "user.query"),
      fix: finding.fix,
    })),
  };
}

function nameOf(step: PlanStep): string | UntrustedText {
  const table = step.tables?.[0];
  if (table !== undefined) return checkedOrUntrusted(table, "schema.identifier");
  const quoted = /"([^"]+)"/.exec(step.sql);
  const name = quoted?.[1];
  if (name !== undefined) return checkedOrUntrusted(name, "schema.identifier");
  return untrustedText(step.sql, "user.query");
}

function objectKindOf(kind: StepKind): string {
  if (kind.includes("column")) return "column";
  if (kind.includes("constraint") || kind.includes("check")) return "constraint";
  if (kind.includes("index")) return "index";
  if (kind.includes("enum")) return "enum";
  if (kind.includes("domain")) return "domain";
  if (kind.includes("extension")) return "extension";
  if (kind.includes("function")) return "function";
  if (kind.includes("trigger")) return "trigger";
  if (kind.includes("matview")) return "matview";
  if (kind.includes("view")) return "view";
  if (kind.includes("role") || kind === "grant" || kind === "revoke" || kind.endsWith("default"))
    return "role";
  if (kind.includes("sequence")) return "sequence";
  if (kind.includes("policy") || kind.includes("rls")) return "policy";
  if (kind.includes("table")) return "table";
  return "statement";
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
  identity?: PlanIdentity,
): string {
  return `${JSON.stringify(planDocument(plan, findings, lockText, identity))}\n`;
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
  if (value.probe !== undefined && typeof value.probe !== "string") return false;
  return isClass(value.class) && typeof value.lock === "string" && typeof value.sql === "string";
}

function isFinding(value: unknown): value is PlanFindingJson {
  if (!isRecord(value)) return false;
  return (
    (value.severity === "error" || value.severity === "warning") &&
    typeof value.code === "string" &&
    typeof value.place === "string" &&
    (typeof value.reason === "string" || isUntrusted(value.reason)) &&
    typeof value.fix === "string"
  );
}

function isUntrusted(value: unknown): value is UntrustedText {
  if (!isRecord(value)) return false;
  return (
    value.untrusted === true &&
    typeof value.origin === "string" &&
    typeof value.text === "string" &&
    typeof value.truncated === "boolean" &&
    typeof value.modified === "boolean"
  );
}

function isClass(value: unknown): value is MigrationClass {
  return value === "expand" || value === "contract" || value === "unclassified";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
