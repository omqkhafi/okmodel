/**
 * Public entry for the `okmodel` package.
 *
 * Application code imports `OkmError`, `safe`, the row types, and the driver
 * types from here. Catalog builders and the helpers a dialect author calls
 * live on `okmodel/internal`, so `table` and `index` on this entry are not a
 * second schema API.
 */

export {
  CATALOG_CODES,
  COLUMN_CODES,
  ERROR_CATEGORIES,
  ERROR_KINDS,
  OkmError,
  safe,
  type CatalogCode,
  type ColumnCode,
  type QueryCode,
  type ErrorCategory,
  type ErrorColumns,
  type ErrorFields,
  type ErrorFix,
  type ErrorKind,
  type ErrorLog,
  type ErrorStatuses,
  type HttpError,
  type HttpErrorBody,
  type OkmErrorOptions,
  type SafeResult,
} from "./error.js";

export type {
  AnySchema,
  AnyTableShape,
  Insert,
  Register,
  Row,
  SchemaOf,
  TableName,
  Update,
} from "./rows.js";

export type {
  DescribeResult,
  DriverCapabilities,
  DriverConnection,
  DriverErrorFields,
  DriverFailureKind,
  DriverPool,
  DriverPoolConfig,
  DriverStats,
  ExecuteOptions,
  ExecuteResult,
  Notice,
  PreparedMode,
  Statement,
  TransactionMode,
  WireValue,
} from "./driver.js";
