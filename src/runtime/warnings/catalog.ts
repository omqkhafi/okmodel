/**
 * Static warning rules (OKM2xxx).
 *
 * The code number is the type. The level is configuration. A code is never
 * reused or renumbered. This module is the sentence source for the doctor
 * pages. It is not on the runtime entry.
 */

/** `off` reports nothing. `error` throws. `hint` and `warn` report. */
export type WarningLevel = "off" | "hint" | "warn" | "error";

/** How serious a rule is before a project overrides its level. */
export type WarningSeverity = "low" | "medium" | "high";

/** When a rule is evaluated. */
export type WarningPhase = "build" | "check" | "dev-runtime" | "production-runtime";

/** Whether the rule reads the query or a later observation. */
export type WarningEvidence = "static" | "observed";

/** One call-site or project ignore. `reason` is required. */
export type WarningIgnore = {
  readonly rule: string;
  readonly reason: string;
};

/** One safe alternative, in the same shape as an error page. */
export type WarningAlternative = {
  readonly text: string;
  readonly docs: string;
};

/** One escape hatch. A person writes the reason. */
export type WarningHatch = {
  readonly name: string;
  readonly requiresHumanReason: true;
  readonly docs: string;
};

/** One registered rule. */
export type WarningRule = {
  readonly code: string;
  readonly rule: string;
  readonly title: string;
  readonly summary: string;
  readonly fix: string;
  readonly defaultLevel: WarningLevel;
  readonly severity: WarningSeverity;
  readonly phase: WarningPhase;
  readonly evidence: WarningEvidence;
  readonly safeAlternatives: readonly WarningAlternative[];
  readonly escapeHatches: readonly WarningHatch[];
};

/** Offsets above this many rows are OKM2004. */
export const OFFSET_LIMIT = 1000;

/** Value lists above this many elements are OKM2007. */
export const LIST_LIMIT = 500;

/** Include products above this many rows are OKM2008. */
export const FANOUT_LIMIT = 10_000;

/**
 * One safe alternative pointing at the page section.
 *
 * @param code - Spec code
 * @param text - What to do instead
 * @returns The alternative
 */
function alt(code: string, text: string): WarningAlternative {
  return { text, docs: `docs/errors/${code}.md#page` };
}

/**
 * The ignore hatch. The reason is required wherever the hatch is used.
 *
 * @param code - Spec code
 * @returns The hatch
 */
function hatch(code: string): WarningHatch {
  return { name: "ignore", requiresHumanReason: true, docs: `docs/errors/${code}.md#escape` };
}

/**
 * Registered query-behaviour rules, in numeric order.
 *
 * 2000–2099 is query behaviour. 2100–2199 is schema. 2200–2299 is operations.
 */
export const WARNING_RULES: readonly WarningRule[] = [
  {
    code: "OKM2004",
    rule: "deep-offset",
    title: "Deep offset",
    summary: "An offset past 1,000 rows makes the database scan every skipped row.",
    fix: "Use page() with a cursor.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "dev-runtime",
    evidence: "static",
    safeAlternatives: [alt("OKM2004", "Use page() with a cursor.")],
    escapeHatches: [hatch("OKM2004")],
  },
  {
    code: "OKM2005",
    rule: "unordered-limit",
    title: "Unordered limit",
    summary:
      "A limit whose order does not end in a unique key can return a different row set each time.",
    fix: "End orderBy with the primary key or a unique column.",
    defaultLevel: "warn",
    severity: "high",
    phase: "dev-runtime",
    evidence: "static",
    safeAlternatives: [alt("OKM2005", "End orderBy with the primary key or a unique column.")],
    escapeHatches: [hatch("OKM2005")],
  },
  {
    code: "OKM2007",
    rule: "large-in-list",
    title: "Large value list",
    summary: "A value list longer than 500 elements sends one parameter per element.",
    fix: "Filter with = any(array) so the list is one parameter.",
    defaultLevel: "warn",
    severity: "medium",
    phase: "dev-runtime",
    evidence: "static",
    safeAlternatives: [alt("OKM2007", "Filter with = any(array) so the list is one parameter.")],
    escapeHatches: [hatch("OKM2007")],
  },
  {
    code: "OKM2008",
    rule: "wide-fan-out",
    title: "Wide fan-out",
    summary: "An include multiplies the parent limit by nested limits past 10,000 rows.",
    fix: "Lower the parent limit or an include limit.",
    defaultLevel: "warn",
    severity: "high",
    phase: "dev-runtime",
    evidence: "static",
    safeAlternatives: [alt("OKM2008", "Lower the parent limit or an include limit.")],
    escapeHatches: [hatch("OKM2008")],
  },
];

/**
 * A rule by its kebab-case id.
 *
 * @param rule - Rule id
 * @returns The rule, or `undefined`
 */
export function warningRule(rule: string): WarningRule | undefined {
  return WARNING_RULES.find((item) => item.rule === rule);
}

/**
 * Reports whether a value is a plain object.
 *
 * @param value - Candidate
 * @returns `true` for a non-null object that is not an array
 */
export function isWarningRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
