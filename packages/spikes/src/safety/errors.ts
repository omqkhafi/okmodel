/**
 * Spike errors for identifier checks and final safety verification.
 *
 * Codes are the ones the spec already names. This spike does not invent new
 * OKM numbers.
 */

/** Error codes this spike throws. */
export type SafetyCode = "OKM1101" | "OKM1102" | "OKM1120" | "OKM1121" | "OKM1190";

/**
 * One broken rule.
 *
 * `contribution` names the provenance that caused it, or `missing` when the
 * rule was omitted rather than contradicted.
 */
export type Violation = {
  readonly code: SafetyCode;
  readonly rule: string;
  readonly table: string;
  readonly detail: string;
  readonly contribution: string;
};

/**
 * Failure from identifier validation, filter parsing, or final safety verification.
 */
export class SafetyError extends Error {
  /** Spec error code. */
  readonly code: SafetyCode;
  /** Rule name of the first violation in stable order. */
  readonly rule: string;
  /** Every violation, sorted so check order cannot change the outcome. */
  readonly violations: readonly Violation[];

  /**
   * @param violations - Problems found. Stored in stable order.
   */
  constructor(violations: readonly Violation[]) {
    const sorted = sortViolations(violations);
    const first = sorted[0];
    const extra = sorted.length > 1 ? ` (+${String(sorted.length - 1)} more)` : "";
    super(
      first === undefined
        ? "OKM1190"
        : `${first.code} ${first.rule}: ${first.detail} [${first.contribution}]${extra}`,
    );
    this.name = "SafetyError";
    this.code = first?.code ?? "OKM1190";
    this.rule = first?.rule ?? "unknown";
    this.violations = sorted;
  }
}

/**
 * Sorts violations so two runs report the same list.
 *
 * @param violations - Unsorted problems
 * @returns A new array
 */
export function sortViolations(violations: readonly Violation[]): readonly Violation[] {
  return [...violations].sort((left, right) =>
    violationKey(left).localeCompare(violationKey(right)),
  );
}

/**
 * Stable identity of a violation.
 *
 * @param violation - One problem
 * @returns A comparable key
 */
export function violationKey(violation: Violation): string {
  return `${violation.code}\0${violation.rule}\0${violation.table}\0${violation.contribution}\0${violation.detail}`;
}

/**
 * Builds one violation.
 *
 * @param code - Spec code
 * @param rule - Short rule name
 * @param table - Table the rule applies to, or `""` when it does not
 * @param detail - What failed
 * @param contribution - Provenance label, or `missing`
 * @returns The violation
 */
export function violation(
  code: SafetyCode,
  rule: string,
  table: string,
  detail: string,
  contribution: string,
): Violation {
  return { code, rule, table, detail, contribution };
}
