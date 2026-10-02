/**
 * Public entry for `okmodel/migrate`.
 *
 * Planning, build artifacts, and `defineConfig`. Applying a plan is P16B.
 */

export { loadTrustedCatalog } from "../../contracts/catalog/document.js";
export { defineConfig, type MigrateConfig } from "./config.js";
export { run, type CommandIo } from "./commands.js";
export { catalogsEqual } from "./equal.js";
export {
  formatPlan,
  planMigration,
  staleRenames,
  type MigrationClass,
  type MigrationPlan,
  type PlanRequest,
  type PlanStep,
} from "./plan.js";
export {
  buildProject,
  checkProject,
  generateProject,
  planProject,
  unlistedTableFiles,
} from "./project.js";
export { parseReplace, type Replacement } from "./values.js";
