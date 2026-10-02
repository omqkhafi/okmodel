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
 * Reads a string field from an unknown error object.
 *
 * @param error - Caught value
 * @param key - Field name
 * @returns The string, or `undefined`
 */
export function errorField(error: unknown, key: string): string | undefined {
  if (typeof error !== "object" || error === null || !(key in error)) return undefined;
  const value: unknown = Reflect.get(error, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Maps a driver exception into {@link DriverError}.
 *
 * {@link OkmError} and {@link DriverError} pass through. A batch index on an
 * existing {@link DriverError} is applied with {@link DriverError.at}.
 *
 * @param error - Caught value
 * @param batchIndex - Statement index, or `null` at commit
 * @returns A normalised error
 */
export function mapDriverError(error: unknown, batchIndex?: number | null): unknown {
  if (error instanceof OkmError) return error;
  if (error instanceof DriverError) {
    return batchIndex === undefined ? error : error.at(batchIndex);
  }
  const message = error instanceof Error ? error.message : "driver error";
  return new DriverError(
    message,
    driverFields({
      sqlstate: errorField(error, "code") ?? errorField(error, "sqlstate"),
      constraint: errorField(error, "constraint_name") ?? errorField(error, "constraint"),
      table: errorField(error, "table_name") ?? errorField(error, "table"),
      column: errorField(error, "column_name") ?? errorField(error, "column"),
      detail: errorField(error, "detail"),
      cause: error,
      batchIndex,
    }),
  );
}

/**
 * Copies defined driver fields. Undefined keys stay absent (`exactOptionalPropertyTypes`).
 *
 * @param input - Fields, including ones that may be absent
 * @returns Fields safe to pass to {@link DriverError}
 */
function driverFields(input: {
  readonly sqlstate?: string | undefined;
  readonly constraint?: string | undefined;
  readonly table?: string | undefined;
  readonly column?: string | undefined;
  readonly detail?: string | undefined;
  readonly cause?: unknown;
  readonly batchIndex?: number | null | undefined;
  readonly kind?: DriverFailureKind | undefined;
}): DriverErrorFields {
  const fields: {
    sqlstate?: string;
    constraint?: string;
    table?: string;
    column?: string;
    detail?: string;
    cause?: unknown;
    batchIndex?: number | null;
    kind?: DriverFailureKind;
  } = {};
  if (input.sqlstate !== undefined) fields.sqlstate = input.sqlstate;
  if (input.constraint !== undefined) fields.constraint = input.constraint;
  if (input.table !== undefined) fields.table = input.table;
  if (input.column !== undefined) fields.column = input.column;
  if (input.detail !== undefined) fields.detail = input.detail;
  if (input.cause !== undefined) fields.cause = input.cause;
  if (input.batchIndex !== undefined) fields.batchIndex = input.batchIndex;
  if (input.kind !== undefined) fields.kind = input.kind;
  return fields;
}
