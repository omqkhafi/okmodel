/**
 * Final safety verification (`okmodel/safety`).
 *
 * A registry and a property harness. Later steps register the rules they own.
 * This module does not hard-code those rules, and the application startup
 * graph does not import it.
 */

import { OkmError } from "../../contracts/error.js";
import { callerLocation } from "../../contracts/location.js";
import { installSafetyHook, type SafetyContribution, type SafetyHatch } from "../safety-hook.js";

export type { SafetyContribution, SafetyHatch };

/** What one registered rule sees. */
export type SafetyInput = {
  /** Contributions the pipeline recorded, including the caller. */
  readonly contributions: readonly SafetyContribution[];
  /**
   * Contributions recorded before a later step ran.
   *
   * One that is missing from {@link SafetyInput.contributions} is `dropped`.
   */
  readonly recorded?: readonly SafetyContribution[];
  /** Escape hatches with a reason. A blank reason is itself a violation. */
  readonly hatches?: readonly SafetyHatch[];
};

/** One broken rule. */
export type SafetyViolation = {
  readonly rule: string;
  readonly contribution: string;
  /** `file.ts:line` of the rule, when it was recorded. */
  readonly source?: string;
  readonly detail: string;
};

/**
 * A rule a later step registers.
 *
 * `check` returns violations. It does not throw. The registry sorts them.
 */
export type SafetyRule = {
  readonly name: string;
  /** Who added the rule. */
  readonly contribution: string;
  /**
   * `file.ts:line`.
   *
   * {@link registerRule} records the caller when this is omitted.
   */
  readonly source?: string;
  /**
   * @param input - Contributions and hatches for one query
   * @returns Violations. Empty when the rule holds
   */
  check(input: SafetyInput): readonly SafetyViolation[];
};

/**
 * OKM1190. `violations` is every broken rule, in stable order.
 *
 * `rule` and `contribution` repeat the first of that list.
 */
export class SafetyError extends OkmError {
  /** Rule name of the first violation. */
  readonly rule: string;
  /** Contribution of the first violation. */
  readonly contribution: string;
  /** Every violation, sorted. */
  readonly violations: readonly SafetyViolation[];

  /**
   * @param violations - Broken rules, already in stable order
   */
  constructor(violations: readonly SafetyViolation[]) {
    const first = violations[0];
    const rule = first?.rule ?? "unknown";
    const contribution = first?.contribution ?? "unknown";
    const extra = violations.length > 1 ? ` (+${String(violations.length - 1)} more)` : "";
    const source = first?.source === undefined ? "" : ` (${first.source})`;
    super(
      "OKM1190",
      first === undefined
        ? "A safety check failed."
        : `${rule} [${contribution}]${source}: ${first.detail}${extra}`,
    );
    this.rule = rule;
    this.contribution = contribution;
    this.violations = violations;
  }
}

const rules: SafetyRule[] = [];

/**
 * Registers one rule and installs the read-path hook.
 *
 * The returned function removes that rule. The hook is cleared when no rules
 * remain, so a query does not call into this module.
 *
 * @param rule - The check. A missing `source` is the caller's file and line
 * @returns Removes this registration
 */
/**
 * Registers the field-exposure rule.
 *
 * A contribution that shows a hidden field, reveals a sensitive value, or
 * sets a guarded field without `{ allow }` is OKM1190. The package does not
 * register it on import (`sideEffects` is false). Call this once.
 *
 * The contribution text is the whole subject the rule can see. P21's input
 * has no schema and no query, so the planner phrases the verdict
 * (`excluded`, `redacted`, `absent`, `allowed`) and a leak is the words
 * `shown`, `revealed`, or `set`.
 *
 * @returns Removes this registration
 */
export function registerFieldExposure(): () => void {
  return registerRule({
    name: "exposure",
    contribution: "field-exposure",
    check(input) {
      const allowed = new Set<string>();
      if (input.hatches !== undefined) {
        for (const hatch of input.hatches) {
          if (hatch.name === "allow" && hatch.reason.trim().length > 0) allowed.add(hatch.reason);
        }
      }
      const violations: SafetyViolation[] = [];
      for (const item of input.contributions) {
        if (!leaked(item.rule, item.contribution)) continue;
        if (item.rule === "guarded" && permitted(item.contribution, allowed)) continue;
        violations.push({
          rule: item.rule,
          contribution: item.contribution,
          ...(item.source !== undefined ? { source: item.source } : {}),
          detail: exposureDetail(item.rule),
        });
      }
      return violations;
    },
  });
}

function leaked(rule: string, contribution: string): boolean {
  if (rule === "hidden") return contribution.includes(" shown");
  if (rule === "sensitive") return contribution.includes(" revealed");
  if (rule === "guarded") return contribution.includes(" set");
  return false;
}

function permitted(contribution: string, allowed: ReadonlySet<string>): boolean {
  for (const reason of allowed) {
    if (contribution.includes(`${reason} set`)) return true;
  }
  return false;
}

function exposureDetail(rule: string): string {
  if (rule === "hidden") return "A hidden field was returned.";
  if (rule === "sensitive") return "A sensitive value was shown.";
  return "A guarded field was set from input.";
}

export function registerRule(rule: SafetyRule): () => void {
  const source = rule.source ?? callerLocation(1);
  const stored: SafetyRule =
    source === undefined || rule.source !== undefined ? rule : { ...rule, source };
  rules.push(stored);
  installSafetyHook(runHook);
  return () => {
    const index = rules.indexOf(stored);
    if (index >= 0) rules.splice(index, 1);
    if (rules.length === 0) installSafetyHook(undefined);
  };
}

/**
 * Runs the registered rules.
 *
 * @param input - Contributions, an optional earlier recording, and hatches
 * @returns Violations in stable order. Empty when every rule holds
 */
export function review(input: SafetyInput): readonly SafetyViolation[] {
  const violations: SafetyViolation[] = [];
  const hatches: SafetyHatch[] = [];
  if (input.hatches !== undefined) {
    for (const hatch of input.hatches) {
      if (hatch.reason.trim().length === 0) {
        violations.push({
          rule: "hatch",
          contribution: hatch.name,
          detail: "An escape hatch needs a reason.",
        });
        continue;
      }
      hatches.push(hatch);
    }
  }
  if (input.recorded !== undefined) {
    for (const item of input.recorded) {
      if (present(item, input.contributions)) continue;
      violations.push({
        rule: "dropped",
        contribution: item.contribution,
        ...(item.source !== undefined ? { source: item.source } : {}),
        detail: `${item.rule} was removed.`,
      });
    }
  }
  const seen: SafetyInput =
    input.hatches === undefined || hatches.length === input.hatches.length
      ? input
      : {
          contributions: input.contributions,
          ...(input.recorded !== undefined ? { recorded: input.recorded } : {}),
          hatches,
        };
  for (const rule of rules) {
    for (const found of rule.check(seen)) {
      violations.push(
        found.source === undefined && rule.source !== undefined
          ? { ...found, source: rule.source }
          : found,
      );
    }
  }
  violations.sort((left, right) => violationKey(left).localeCompare(violationKey(right)));
  return violations;
}

/**
 * Throws OKM1190 when {@link review} finds a violation.
 *
 * @param input - Contributions, an optional earlier recording, and hatches
 */
export function verify(input: SafetyInput): void {
  const violations = review(input);
  if (violations.length > 0) throw new SafetyError(violations);
}

/**
 * Checks each case, then again with the registered rules reversed.
 *
 * The two verdicts must match. A later step copies this, registers its rule,
 * and passes its cases. Rule order is not part of the verdict.
 *
 * @param cases - Subjects to check
 * @returns Violations for each case, in case order
 */
export function safetyProperty(
  cases: readonly SafetyInput[],
): readonly (readonly SafetyViolation[])[] {
  const forward = cases.map((item) => review(item));
  const snapshot = rules.slice();
  rules.reverse();
  try {
    for (let index = 0; index < cases.length; index += 1) {
      const item = cases[index];
      if (item === undefined) continue;
      if (!sameViolations(forward[index] ?? [], review(item))) {
        throw new Error("safety.property: rule order changed the verdict.");
      }
    }
  } finally {
    rules.length = 0;
    for (const rule of snapshot) rules.push(rule);
  }
  return forward;
}

function runHook(
  contributions: readonly SafetyContribution[],
  hatches: readonly SafetyHatch[] | undefined,
): void {
  verify({
    contributions,
    ...(hatches !== undefined ? { hatches } : {}),
  });
}

function present(
  needle: SafetyContribution,
  contributions: readonly SafetyContribution[],
): boolean {
  for (const item of contributions) {
    if (
      item.rule === needle.rule &&
      item.contribution === needle.contribution &&
      item.provenance === needle.provenance
    ) {
      return true;
    }
  }
  return false;
}

function violationKey(violation: SafetyViolation): string {
  return `${violation.rule}\0${violation.contribution}\0${violation.detail}`;
}

function sameViolations(
  left: readonly SafetyViolation[],
  right: readonly SafetyViolation[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return false;
    if (violationKey(a) !== violationKey(b)) return false;
  }
  return true;
}
