/**
 * Errors an adapter throws.
 *
 * Database failures stay {@link DriverError}. The Postgres dialect maps that
 * to {@link OkmError}. Acquire exhaustion is OKM1846 on {@link OkmError}:
 * that code is the pool's own deadline (spec §15.2), not a SQLSTATE.
 */

import { OkmError } from "../contracts/error.js";
import type { DriverErrorFields, DriverFailureKind } from "../contracts/driver.js";

/**
 * A driver failure normalised to the contract fields.
 *
 * `batchIndex` is `null` except on a failed batch statement, where it is that
 * statement's index. A commit failure (a deferred constraint) stays `null`.
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
  /** Driver or server error underneath. */
  override readonly cause: unknown;
  /** Statement index inside a batch, or `null` when this is not that case. */
  readonly batchIndex: number | null;
  /** `timeout` or `cancelled`. Absent on a database error. */
  readonly kind: DriverFailureKind | undefined;

  /**
   * @param message - Error text
   * @param fields - Normalised fields
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
    this.batchIndex = fields.batchIndex === undefined ? null : fields.batchIndex;
    this.kind = fields.kind;
  }

  /**
   * Same error with a batch index.
   *
   * @param batchIndex - Statement index, or `null` at commit
   * @returns A new error when the index differs
   */
  at(batchIndex: number | null): DriverError {
    if (this.batchIndex === batchIndex) return this;
    return new DriverError(
      this.message,
      driverFields({
        sqlstate: this.sqlstate,
        constraint: this.constraint,
        table: this.table,
        column: this.column,
        detail: this.detail,
        cause: this.cause,
        kind: this.kind,
        batchIndex,
      }),
    );
  }
}

/**
 * An abort from the caller's `signal` (D124).
 *
 * @param cause - Underlying error, when one exists
 * @returns Kind `cancelled`
 */
export function cancelled(cause?: unknown): DriverError {
  return new DriverError("The call was cancelled.", driverFields({ kind: "cancelled", cause }));
}

/**
 * A statement, transaction, or batch deadline (D124).
 *
 * @param cause - Underlying error, when one exists
 * @returns Kind `timeout`
 */
export function timedOut(cause?: unknown): DriverError {
  return new DriverError("The call timed out.", driverFields({ kind: "timeout", cause }));
}

/**
 * A commit was sent and its result never arrived (OKM1401 once mapped).
 *
 * @param cause - Underlying error, when one exists
 * @returns Kind `outcome_unknown`, batch index `null`
 */
export function outcomeUnknown(cause?: unknown): DriverError {
  return new DriverError(
    "The commit outcome is unknown. The result never arrived.",
    driverFields({ kind: "outcome_unknown", cause, batchIndex: null }),
  );
}

/**
 * The pool did not hand out a connection within `timeouts.acquire`.
 *
 * @returns OKM1846, kind `timeout`
 */
export function acquireTimeout(): OkmError {
  return new OkmError(
    "OKM1846",
    "Timed out waiting for a connection. This pool did not hand one out within timeouts.acquire.",
  );
}

/**
 * Copies defined driver fields. Undefined keys stay absent (`exactOptionalPropertyTypes`).
 *
 * @param input - Fields, including ones that may be absent
 * @returns Fields safe to pass to {@link DriverError}
 */
export function driverFields(input: {
  readonly sqlstate?: string | undefined;
  readonly constraint?: string | undefined;
  readonly table?: string | undefined;
  readonly column?: string | undefined;
  readonly detail?: string | undefined;
  readonly cause?: unknown;
  readonly batchIndex?: number | null | undefined;
  readonly kind?: DriverFailureKind | undefined;
}): DriverErrorFields {
  const fields: Record<string, unknown> = {};
  const keys = [
    "sqlstate",
    "constraint",
    "table",
    "column",
    "detail",
    "cause",
    "batchIndex",
    "kind",
  ] as const;
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}
