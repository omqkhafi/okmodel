/**
 * Errors an adapter may throw.
 *
 * Drivers do not construct `OkmError`. `DriverCallError` of kind
 * `outcome_unknown` is the signal a dialect would map to OKM1401.
 */

/** Fields spec section 4.2 requires on `DriverError`. */
export type DriverErrorFields = {
  readonly sqlstate?: string | undefined;
  readonly constraint?: string | undefined;
  readonly table?: string | undefined;
  readonly column?: string | undefined;
  readonly detail?: string | undefined;
  readonly cause?: unknown;
  /** Set when a batch statement fails. Null when the failure is at commit. */
  readonly batchIndex?: number | null | undefined;
};

/**
 * A database error normalised from the driver.
 *
 * `batchIndex` is set for a failed batch. A number is the statement that
 * failed. Null means the statements ran and the commit failed, which is how
 * a deferred constraint reports.
 */
export class DriverError extends Error {
  /** SQLSTATE, when the server sent one. */
  readonly sqlstate: string | undefined;
  /** Constraint name, when the server sent one. */
  readonly constraint: string | undefined;
  /** Table name, when the server sent one. */
  readonly table: string | undefined;
  /** Column name, when the server sent one. */
  readonly column: string | undefined;
  /** Server detail line. */
  readonly detail: string | undefined;
  /** Driver error this was mapped from. */
  override readonly cause: unknown;
  /** Statement index inside a batch, or null at commit time. */
  readonly batchIndex: number | null;

  /**
   * @param message - Error text
   * @param fields - Normalised server fields
   */
  constructor(message: string, fields: DriverErrorFields = {}) {
    super(message);
    this.name = "DriverError";
    this.sqlstate = fields.sqlstate;
    this.constraint = fields.constraint;
    this.table = fields.table;
    this.column = fields.column;
    this.detail = fields.detail;
    this.cause = fields.cause;
    this.batchIndex = fields.batchIndex ?? null;
  }
}

/** Why a call ended without a statement result. */
export type CallKind = "cancelled" | "timeout" | "outcome_unknown";

/**
 * Cancellation, timeout, or a batch whose result never arrived.
 *
 * `outcome_unknown` is not a claim that the server rolled back.
 */
export class DriverCallError extends Error {
  /** Which contract outcome this is. */
  readonly kind: CallKind;
  /** Driver or server error underneath, when there was one. */
  override readonly cause: unknown;

  /**
   * @param kind - Contract outcome
   * @param cause - Underlying error
   * @param message - Text. Defaults to the kind
   */
  constructor(kind: CallKind, cause?: unknown, message = kind) {
    super(message);
    this.name = "DriverCallError";
    this.kind = kind;
    this.cause = cause;
  }
}

const LOSS_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "ECONNRESET",
  "EPIPE",
  "ECONNREFUSED",
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08003",
  "08006",
  "08001",
]);

/**
 * Reads a string field from an unknown error object.
 *
 * @param error - Caught value
 * @param key - Field name
 * @returns The string, or undefined
 */
export function errorField(error: unknown, key: string): string | undefined {
  if (typeof error !== "object" || error === null || !(key in error)) return undefined;
  const value = Reflect.get(error, key) as unknown;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Returns whether the server connection died or the result can no longer arrive.
 *
 * @param error - Caught value
 * @returns True when the client must not claim a rollback
 */
export function isConnectionLoss(error: unknown): boolean {
  if (error instanceof DriverCallError && error.kind === "outcome_unknown") return true;
  const code = errorField(error, "code");
  if (code !== undefined && LOSS_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : "";
  return (
    message.includes("CONNECTION_CLOSED") ||
    message.includes("socket.write") ||
    message.includes("terminating connection")
  );
}

/**
 * Maps a driver exception into `DriverError`.
 *
 * Connection loss and call errors pass through so the batch runner can decide.
 *
 * @param error - Caught value
 * @param batchIndex - Statement index, or null at commit time
 * @returns A normalised error
 */
export function mapDriverError(error: unknown, batchIndex?: number | null): unknown {
  if (error instanceof DriverCallError) return error;
  if (isConnectionLoss(error)) return error;
  if (error instanceof DriverError) {
    if (batchIndex === undefined || error.batchIndex === batchIndex) return error;
    return new DriverError(error.message, {
      sqlstate: error.sqlstate,
      constraint: error.constraint,
      table: error.table,
      column: error.column,
      detail: error.detail,
      cause: error.cause,
      batchIndex,
    });
  }
  const message = error instanceof Error ? error.message : "driver error";
  return new DriverError(message, {
    sqlstate: errorField(error, "code") ?? errorField(error, "sqlstate"),
    constraint: errorField(error, "constraint_name") ?? errorField(error, "constraint"),
    table: errorField(error, "table_name") ?? errorField(error, "table"),
    column: errorField(error, "column_name") ?? errorField(error, "column"),
    detail: errorField(error, "detail"),
    cause: error,
    batchIndex,
  });
}
