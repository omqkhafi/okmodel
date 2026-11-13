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
 * Whether known skips sit above sampling noise around a 25% rate.
 *
 * The bound is the 25% mean plus three binomial standard deviations:
 * `N*0.25 + 3*sqrt(N*0.25*0.75)`. A flat quarter treats an ordinary draw as
 * drift. A generator that mostly hits known bugs still fails. Unknown
 * failures are not this check.
 *
 * @param report - Counters for the run
 * @returns `true` when known skips exceed that bound
 */
export function knownSkipExceedsBudget(report: LifecycleReport): boolean {
  if (report.ran === 0) return false;
  const mean = report.ran * 0.25;
  const spread = 3 * Math.sqrt(report.ran * 0.25 * 0.75);
  return report.known > mean + spread;
}
