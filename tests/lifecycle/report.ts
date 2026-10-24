/**
 * Counts for one lifecycle property run.
 */

/** How one run finished. */
export type LifecycleReport = {
  /** Cases the property executed. */
  readonly ran: number;
  /** Cases that held the generate / check / apply / push invariants. */
  readonly passed: number;
  /** Cases skipped because a known bug matched the failure. */
  readonly known: number;
  /** Failures that are not on the known list. */
  readonly unknown: number;
};

/**
 * One line: cases run, passed, skipped as known, and unknown failures.
 *
 * @param report - Counters for the run
 * @returns The log line
 */
export function formatLifecycleReport(report: LifecycleReport): string {
  return `[lifecycle] ran=${String(report.ran)} passed=${String(report.passed)} known=${String(report.known)} unknown=${String(report.unknown)}`;
}

/**
 * Whether known skips are more than a quarter of the cases.
 *
 * A list that matches on tags alone hides real failures. The run fails closed.
 *
 * @param report - Counters for the run
 * @param limit - Fraction of cases that may be known skips. The default is 25%
 * @returns `true` when the known share is above the limit
 */
export function knownSkipExceedsBudget(report: LifecycleReport, limit = 0.25): boolean {
  if (report.ran === 0) return false;
  return report.known / report.ran > limit;
}
