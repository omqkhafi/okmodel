/**
 * Shared statement parameter budget (B-40, B-48).
 *
 * Loaded only when a statement goes over the limit. Small statements pay one
 * integer compare in the path that already holds the parameter list.
 *
 * The wire protocol allows 65,535. postgres.js refuses at 65,534
 * (`MAX_PARAMETERS_EXCEEDED`), so the runtime ceiling is 65,533 and OKM1126
 * fires before that driver error.
 */

import { OkmError } from "../contracts/error.js";

/** Max parameters on one statement across supported drivers (B-48). */
export const PG_PARAM_LIMIT = 65_533;

/**
 * Refuses a statement that exceeds the protocol parameter limit.
 *
 * @param count - Parameter count of the finished statement
 */
export function refuseParamLimit(count: number): never {
  throw new OkmError("OKM1126", `${String(count)} parameters (max ${String(PG_PARAM_LIMIT)}).`, {
    kind: "invalid",
    retryable: false,
    fix: { summary: "Chunk the work, or use = any(array)." },
  });
}

/**
 * Throws OKM1126 when `count` is above {@link PG_PARAM_LIMIT}.
 *
 * @param count - Parameter count of the finished statement
 */
export function assertParamCount(count: number): void {
  if (count <= PG_PARAM_LIMIT) return;
  refuseParamLimit(count);
}
