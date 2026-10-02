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
export {
  connectionDetailHits,
  initialRunState,
  targetPlanFromMigration,
  type PlannedStep,
  type StepClass,
  type TargetPlan,
  type TargetRunRecord,
  type TargetRunState,
} from "./plan.js";
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
