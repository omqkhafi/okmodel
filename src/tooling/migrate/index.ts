/**
 * Public entry for `okmodel/migrate`.
 *
 * `defineConfig`, its types, and `provision` for one configured target.
 * `describe` and `buildCatalog` are the programmatic schema API.
 * `plan`, `apply`, and `status` match the CLI commands (D298).
 */

export { defineConfig, type MigrateConfig, type TargetInput } from "./config.js";
export { type LogicalIdentity } from "./export.js";
export { buildCatalog, describe, type SchemaDescription } from "./schema-api.js";
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
