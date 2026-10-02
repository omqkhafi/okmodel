/**
 * Decimal text for finite numbers.
 *
 * Shared by numeric, real, double, and geometry so the spelling stays one place.
 */

import { rejected } from "./misuse.js";

/**
 * Spells a finite number as a canonical decimal literal.
 *
 * Negative zero becomes `0`.
 *
 * @param value - Finite number
 * @param role - Type name used when the value is not finite
 * @returns Decimal text
 */
export function decimalText(value: number, role: string): string {
  if (!Number.isFinite(value)) {
    rejected(
      `${role} ${String(value)} must be a finite number. Infinity and NaN are not accepted.`,
    );
  }
  return Object.is(value, -0) ? "0" : JSON.stringify(value);
}
