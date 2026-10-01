/**
 * A migration the spike refuses to plan.
 *
 * `code` is the spec guard this refusal corresponds to (OKM1530, OKM1821).
 */
export class MigrationError extends Error {
  readonly code: string;

  /**
   * @param code - Spec guard
   * @param message - What the planner refused, and the fix when there is one
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
  }
}
