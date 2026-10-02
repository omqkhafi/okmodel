/**
 * Migration spike. Nothing here is part of the published `okmodel` package.
 */

export { applyAndCompare, type ApplyReport } from "./apply.js";
export { diffCatalog, mappedKey, type CatalogDiff, type ColumnRename } from "./diff.js";
export {
  introspectedDriftHash,
  readRewrittenExpressions,
  rewrittenDriftHash,
  rewrittenMismatches,
  scrubSchema,
  structuralDriftHash,
  structuralMismatches,
  type RewrittenExpression,
} from "./equal.js";
export { MigrationError } from "./error.js";
export {
  PROPERTY_SEEDS,
  dependencyPair,
  describePair,
  migrationPair,
  propertyCaseCount,
  propertySeeds,
  renamePair,
  typeChangePair,
  type MigrationOptions,
} from "./generate.js";
export { lockForStatement, lockInfo, type LockInfo, type LockMode } from "./lock.js";
export { timeDiffAndPlan, timeScratch, type PlanTiming, type ScratchTiming } from "./measure.js";
export { planMigration, planSql, type MigrationPlan, type PlanStep } from "./plan.js";
