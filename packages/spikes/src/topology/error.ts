/**
 * Routing failures for the topology spike.
 *
 * Codes are the ones section 15.1 already names. This spike does not invent
 * new OKM numbers.
 */

/** Error codes this spike throws. */
export type TopologyCode = "OKM1840" | "OKM1843" | "OKM1844" | "OKM1846";

/**
 * A routing or pool failure.
 *
 * `fix` is set for OKM1843, where the spec tells the caller to configure a
 * replica or drop the constraint.
 */
export class TopologyError extends Error {
  /** Spec error code. */
  readonly code: TopologyCode;
  /** Timeout for acquire failures. Usage for routing failures. */
  readonly kind: "timeout" | "usage";
  /** Transient for acquire timeouts. Usage for routing failures. */
  readonly category: "transient" | "usage";
  /** What the caller can change. Present on OKM1843. */
  readonly fix: string | undefined;

  /**
   * @param code - Spec error code
   * @param message - What failed
   * @param fix - Caller-facing remedy, when the spec defines one
   */
  constructor(code: TopologyCode, message: string, fix?: string) {
    super(`${code} ${message}`);
    this.name = "TopologyError";
    this.code = code;
    this.fix = fix;
    if (code === "OKM1846") {
      this.kind = "timeout";
      this.category = "transient";
      return;
    }
    this.kind = "usage";
    this.category = "usage";
  }
}

/**
 * `.replica()` was used on an operation that has to run on the primary.
 *
 * @returns OKM1840
 */
export function primaryRequiredReplica(): TopologyError {
  return new TopologyError(
    "OKM1840",
    ".replica() is not valid on an operation that requires the primary.",
  );
}

/**
 * A replica was required and none can serve the read.
 *
 * @param detail - Which filter emptied the candidate list
 * @returns OKM1843
 */
export function noEligibleReplica(detail: string): TopologyError {
  return new TopologyError(
    "OKM1843",
    `No eligible replica (${detail}).`,
    "Configure a replica or drop the .replica() constraint.",
  );
}

/**
 * An automatic read has no eligible replica and `fallback` is `"error"`.
 *
 * @param detail - Which filter emptied the candidate list
 * @returns OKM1844
 */
export function fallbackError(detail: string): TopologyError {
  return new TopologyError("OKM1844", `No eligible replica (${detail}) and fallback is error.`);
}

/**
 * The endpoint's pool did not hand out a connection in time.
 *
 * @param endpoint - Endpoint name
 * @param timeoutMs - How long the caller was willing to wait
 * @returns OKM1846
 */
export function acquireTimeout(endpoint: string, timeoutMs: number): TopologyError {
  return new TopologyError(
    "OKM1846",
    `Timed out acquiring a connection from '${endpoint}' after ${String(timeoutMs)}ms.`,
  );
}
