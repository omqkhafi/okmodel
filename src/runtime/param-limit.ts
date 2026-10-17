/**
 * Postgres protocol parameter budget (B-40).
 *
 * Loaded only when a statement goes over the limit. Small statements pay one
 * integer compare in the path that already holds the parameter list.
 */

import { OkmError } from "../contracts/error.js";

/** Postgres binds at most this many parameters on one statement. */
export const PG_PARAM_LIMIT = 65_535;

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
