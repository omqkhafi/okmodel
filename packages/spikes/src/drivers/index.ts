/**
 * Driver spike. Nothing here is part of the published `okmodel` package.
 */

export { runAtomicBatch } from "./batch.js";
export { DriverCallError, DriverError, isConnectionLoss, type CallKind } from "./errors.js";
export { openPglite } from "./pglite.js";
export {
  openBatchMode,
  openPostgresJs,
  terminateBackend,
  type PostgresJsOptions,
} from "./postgresjs.js";
export {
  assertRegistryLinked,
  CONTRACT_TESTS,
  MANIFESTS,
  manifestFor,
  type DriverManifest,
} from "./registry.js";
export { CASES, CASE_IDS, skipReason } from "./suite.js";
export { renderCompatibility, type ResultsFile, type StatusRecord } from "./table.js";
export type {
  DriverCapabilityFlags,
  DriverConnection,
  DriverPool,
  DriverStats,
  ExecuteOptions,
  ExecuteResult,
  PreparedMode,
  Statement,
} from "./types.js";
