/**
 * A target, registry, or runner refusal.
 *
 * `code` is the spec guard this refusal corresponds to.
 */
export class TargetError extends Error {
  /** Spec guard. */
  readonly code: TargetCode;

  /**
   * @param code - Spec guard
   * @param message - What was refused
   */
  constructor(code: TargetCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "TargetError";
    this.code = code;
  }
}

/** Guards this spike raises. */
export type TargetCode =
  | "OKM1120"
  | "OKM1520"
  | "OKM1522"
  | "OKM1845"
  | "OKM1850"
  | "OKM1851"
  | "OKM1852"
  | "OKM1853";
