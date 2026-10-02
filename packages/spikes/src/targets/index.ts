/**
 * Target spike. Nothing here is part of the published `okmodel` package.
 */

export {
  countApplicationBackends,
  createEmptyDatabase,
  dropDatabasesByPrefix,
  dropEmptyDatabase,
} from "./admin.js";
export { TargetError, type TargetCode } from "./error.js";
export { itemsCatalog, itemsCatalogWithNote } from "./fixture.js";
export { applyToTarget, type TargetApplyResult } from "./apply.js";
export { acquireTargetLock, advisoryLockKey, releaseTargetLock } from "./lock.js";
export {
  connectionDetailHits,
  initialRunState,
  SCHEMA_PLACEHOLDER,
  bindSchema,
  targetPlanFromMigration,
  type PlannedStep,
  type StepClass,
  type TargetPlan,
  type TargetRunRecord,
  type TargetRunState,
} from "./plan.js";
export {
  assertTargetPolicy,
  OPERATION_CLASSES,
  policyDecision,
  type OperationClass,
} from "./policy.js";
export {
  applyRun,
  controlSharedTarget,
  defaultConcurrency,
  type ApplyReport,
  type Rollout,
  type TargetReport,
} from "./runner.js";
export {
  assertTenantCompatible,
  migrationStatus,
  type StatusRow,
  type StatusState,
} from "./status.js";
export {
  dropControlSchema,
  ensureControlSchema,
  readControlRows,
  saveControlRow,
  type ControlRow,
} from "./state.js";
export {
  isAuthFailure,
  openTargetPools,
  type ReservedTarget,
  type TargetPoolStats,
  type TargetPools,
} from "./pool.js";
export {
  createMemoryRegistry,
  type MemoryRegistry,
  type RegistryRole,
  type ResolvedConnection,
  type TenantRegistry,
} from "./registry.js";
export { connectionUrl, destinationCount, resolveTarget, type TargetSource } from "./resolver.js";
export { databaseNameForTenant, sanitizeTenantId, schemaNameForTenant } from "./sanitize.js";
export {
  sharedTarget,
  tenantTargetName,
  type Target,
  type TargetClass,
  type TargetStrategy,
} from "./target.js";
export { formatPostgresUrl, parsePostgresUrl, type PostgresUrlParts } from "./url.js";
