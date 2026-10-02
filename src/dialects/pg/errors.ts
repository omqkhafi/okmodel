/**
 * Maps a Postgres {@link DriverError} to an {@link OkmError} (spec §4.2, §14).
 *
 * Adapters normalise the driver into `DriverError`. They do not construct
 * `OkmError`. Constraint names follow the catalog: `{table}_{nameKey}_{tag}`.
 */

import { isConnectionFailure, isConnectionSqlstate } from "../../contracts/connection.js";
import {
  OkmError,
  matchingParen,
  stripRowValues,
  type ErrorKind,
  type ErrorStatuses,
} from "../../contracts/error.js";

/** Options for {@link mapPostgresError}. */
export type MapPostgresErrorOptions = {
  /**
   * Keep row values on the error. Development only.
   *
   * The summary, the log, and {@link OkmError.fields} still omit them.
   */
  readonly includeValues?: boolean;
  /** Category overrides from `connect({ errors })`. */
  readonly http?: ErrorStatuses;
};

/**
 * Maps a thrown driver error into an {@link OkmError}.
 *
 * An {@link OkmError} passes through. `timeout`, `cancelled`, and
 * `outcome_unknown` follow the driver kind (D124). `57014` without that kind
 * is `timeout`, because `cancelled` comes only from the caller's signal.
 *
 * @param error - Caught value, usually a `DriverError`
 * @param options - `includeValues` keeps row values off the log
 * @returns A categorised error
 */
export function mapPostgresError(error: unknown, options?: MapPostgresErrorOptions): OkmError {
  if (error instanceof OkmError) return error;
  if (!isDriverError(error)) return OkmError.from(error);
  const kind = kindOf(error);
  const columns = columnsOf(error);
  const fieldReason =
    kind === "not_null" ? "not_null" : reasonOf(kind, error.table, error.constraint);
  const values = options?.includeValues === true ? valuesOf(error.detail, columns) : undefined;
  const code = kind === "outcome_unknown" ? "OKM1401" : kind;
  return new OkmError(code, summaryOf(kind, error, columns, fieldReason), {
    kind,
    fieldReason,
    ...(error.table !== undefined ? { table: error.table } : {}),
    ...(columns.length > 0 ? { columns } : {}),
    ...(error.constraint !== undefined ? { constraint: error.constraint } : {}),
    ...(error.sqlstate !== undefined ? { sqlstate: error.sqlstate } : {}),
    batchIndex: error.batchIndex,
    cause: error.cause ?? error,
    ...(options?.includeValues === true && values !== undefined
      ? { includeValues: true, values }
      : {}),
    ...(options?.http !== undefined ? { http: options.http } : {}),
  });
}

type DriverShape = {
  readonly message: string;
  readonly sqlstate: string | undefined;
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;
  readonly detail: string | undefined;
  readonly batchIndex: number | null;
  readonly kind: "timeout" | "cancelled" | "outcome_unknown" | undefined;
  readonly cause: unknown;
};

function isDriverError(error: unknown): error is DriverShape {
  if (!(error instanceof Error) || error.name !== "DriverError") return false;
  return "batchIndex" in error;
}

function kindOf(error: DriverShape): ErrorKind {
  if (error.kind === "timeout" || error.kind === "cancelled" || error.kind === "outcome_unknown") {
    return error.kind;
  }
  const sqlstate = error.sqlstate;
  if (sqlstate !== undefined) {
    const mapped = kindFromSqlstate(sqlstate);
    if (mapped !== undefined) return mapped;
  }
  if (isConnectionFailure(error)) return "unavailable";
  return "driver";
}

function kindFromSqlstate(sqlstate: string): ErrorKind | undefined {
  switch (sqlstate) {
    case "23505":
      return "unique";
    case "23502":
      return "not_null";
    case "23514":
      return "check";
    case "23503":
    case "23001":
      return "foreign_key";
    case "23P01":
      return "exclusion";
    case "23000":
      return "conflict";
    case "40001":
      return "serialization";
    case "40P01":
      return "deadlock";
    case "55P03":
      return "lock_timeout";
    case "57014":
      return "timeout";
    case "40003":
      return "outcome_unknown";
    case "25006":
      return "read_only";
    default:
      if (isConnectionSqlstate(sqlstate)) return "unavailable";
      if (sqlstate.startsWith("22")) return "invalid";
      if (sqlstate.startsWith("53")) return "unavailable";
      return undefined;
  }
}

function reasonOf(
  kind: ErrorKind,
  table: string | undefined,
  constraint: string | undefined,
): string {
  if (constraint === undefined || constraint.length === 0) return kind;
  if (table !== undefined) {
    if (constraint === `${table}_pkey`) return "pkey";
    const prefix = `${table}_`;
    if (constraint.startsWith(prefix)) {
      const rest = constraint.slice(prefix.length);
      const nameKey = nameKeyOf(rest);
      if (nameKey !== undefined) return nameKey;
    }
  }
  return constraint;
}

function nameKeyOf(rest: string): string | undefined {
  const tags = ["_fkey", "_check", "_key"] as const;
  for (const tag of tags) {
    if (rest.endsWith(tag) && rest.length > tag.length) return rest.slice(0, -tag.length);
  }
  return undefined;
}

function columnsOf(error: DriverShape): readonly string[] {
  if (error.column !== undefined && error.column.length > 0) return [unquote(error.column)];
  const detail = error.detail;
  if (detail !== undefined) {
    const fromKey = keyColumns(detail);
    if (fromKey.length > 0) return fromKey;
  }
  const fromMessage = quotedColumn(error.message);
  return fromMessage === undefined ? [] : [fromMessage];
}

function keyColumns(detail: string): readonly string[] {
  const marker = "Key (";
  const start = detail.indexOf(marker);
  if (start === -1) return [];
  const open = start + marker.length - 1;
  const end = matchingParen(detail, open);
  if (end === undefined) return [];
  return splitList(detail.slice(open + 1, end));
}

function valuesOf(
  detail: string | undefined,
  columns: readonly string[],
): Readonly<Record<string, string>> | undefined {
  if (detail === undefined || columns.length === 0) return undefined;
  const marker = "=(";
  const start = detail.indexOf(marker);
  if (start === -1) return undefined;
  const open = start + 1;
  const end = matchingParen(detail, open);
  if (end === undefined) return undefined;
  const parts = splitList(detail.slice(open + 1, end));
  if (parts.length !== columns.length) return undefined;
  const values: Record<string, string> = {};
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const value = parts[index];
    if (column === undefined || value === undefined) continue;
    values[column] = value;
  }
  return values;
}

function quotedColumn(message: string): string | undefined {
  const marker = 'column "';
  const start = message.indexOf(marker);
  if (start === -1) return undefined;
  const from = start + marker.length;
  const end = message.indexOf('"', from);
  if (end === -1) return undefined;
  return message.slice(from, end);
}

function splitList(inner: string): readonly string[] {
  const parts = inner.split(",");
  const names: string[] = [];
  for (const part of parts) {
    const name = unquote(part.trim());
    if (name.length > 0) names.push(name);
  }
  return names;
}

function unquote(name: string): string {
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
    return name.slice(1, -1);
  }
  return name;
}

function summaryOf(
  kind: ErrorKind,
  error: DriverShape,
  columns: readonly string[],
  fieldReason: string,
): string {
  const label = labelOf(kind);
  if (kind === "driver") return stripRowValues(error.message);
  const where = place(error.table, columns);
  if (where === undefined) return label;
  if (fieldReason === kind) return `${label} on ${where}`;
  return `${label} on ${where} (${fieldReason})`;
}

function place(table: string | undefined, columns: readonly string[]): string | undefined {
  if (table === undefined && columns.length === 0) return undefined;
  if (table === undefined) return columns.join(", ");
  if (columns.length === 0) return table;
  if (columns.length === 1) return `${table}.${columns[0] ?? ""}`;
  return `${table} (${columns.join(", ")})`;
}

function labelOf(kind: ErrorKind): string {
  switch (kind) {
    case "unique":
      return "Unique violation";
    case "not_null":
      return "Not-null violation";
    case "check":
      return "Check violation";
    case "foreign_key":
      return "Foreign key violation";
    case "exclusion":
      return "Exclusion violation";
    case "conflict":
      return "Conflict";
    case "invalid":
      return "Invalid value";
    case "serialization":
      return "Serialization failure";
    case "deadlock":
      return "Deadlock";
    case "lock_timeout":
      return "Lock timeout";
    case "timeout":
      return "The call timed out";
    case "cancelled":
      return "The call was cancelled";
    case "unavailable":
      return "The database is unavailable";
    case "outcome_unknown":
      return "The commit outcome is unknown";
    case "read_only":
      return "The database is read-only";
    case "schema_drift":
      return "The database schema does not match this build";
    case "not_found":
      return "No row was found";
    case "not_unique":
      return "More than one row was found";
    case "forbidden":
      return "The operation is forbidden";
    case "driver":
      return "Driver error";
  }
}
