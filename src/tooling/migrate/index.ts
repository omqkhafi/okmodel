/**
 * Public entry for `okmodel/migrate`.
 *
 * Planning, build artifacts, `defineConfig`, and the apply policy. The apply
 * runner loads when a command needs a connection, so importing `defineConfig`
 * does not load a driver.
 */

export { loadTrustedCatalog } from "../../contracts/catalog/document.js";
export { defineConfig, type MigrateConfig, type TargetInput } from "./config.js";
export { run, type CommandIo } from "./commands.js";
export { catalogsEqual } from "./equal.js";
export {
  formatPlan,
  parsePlan,
  planMigration,
  staleRenames,
  type MigrationClass,
  type MigrationPlan,
  type PlanRequest,
  type PlanStep,
} from "./plan.js";
export {
  assertDirectConnection,
  assertTargetAlias,
  assertTargetPolicy,
  listTargets,
  selectTarget,
  type InvokeFlags,
  type PolicyOperation,
  type TargetRecord,
} from "./policy.js";
export {
  buildProject,
  checkProject,
  generateProject,
  planProject,
  projectHead,
  unlistedTableFiles,
} from "./project.js";
export { parseReplace, type Replacement } from "./values.js";
