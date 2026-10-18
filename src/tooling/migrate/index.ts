/**
 * Public entry for `okmodel/migrate`.
 *
 * `defineConfig`, its types, `provision`, and `baseline` for one configured
 * target. `describe` and `buildCatalog` are the programmatic schema API.
 * `plan`, `apply`, and `status` match the CLI commands (D298). `baseline`
 * adopts an existing database (D299).
 */

export { baseline } from "./baseline.js";
export { defineConfig, type MigrateConfig, type TargetInput } from "./config.js";
export { type LogicalIdentity } from "./export.js";
export {
  buildCatalog,
  describe,
  type RequiredExtension,
  type SchemaDescription,
} from "./schema-api.js";
export { provision } from "./provision.js";
export {
  apply,
  plan,
  status,
  type ApplyOptions,
  type ApplyResult,
  type MigrateOptions,
  type PlanOptions,
  type PlanResult,
  type PlanStepResult,
  type StatusResult,
} from "./api.js";
export type { CompatibilityState } from "./status.js";
