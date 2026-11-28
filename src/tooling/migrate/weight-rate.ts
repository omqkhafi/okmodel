/**
 * Duration estimate for a weighted step, with no database import.
 *
 * {@link estimateMs} stays here so a typecheck that loads the fleet config
 * does not open the row probe.
 */

import type { StepWeight } from "./classify.js";

/** Milliseconds per million rows. Measured on real servers, order of magnitude only. */
export const MS_PER_MILLION: Readonly<Record<StepWeight, number>> = {
  blocking: 45_000,
  rewrite: 1_300,
};

/**
 * Estimated duration.
 *
 * @param weight - Step weight
 * @param rows - Rows in the table
 * @returns Milliseconds, rounded
 */
export function estimateMs(weight: StepWeight, rows: number): number {
  return Math.round((rows / 1_000_000) * MS_PER_MILLION[weight]);
}
