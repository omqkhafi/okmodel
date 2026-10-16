/**
 * Public entry for `okmodel/migrate`.
 *
 * `defineConfig`, its types, and `provision` for one configured target.
 * `describe` and `buildCatalog` are the programmatic schema API.
 * The CLI imports planning and apply helpers from their modules.
 */

export { defineConfig, type MigrateConfig, type TargetInput } from "./config.js";
export { type LogicalIdentity } from "./export.js";
export { buildCatalog, describe, type SchemaDescription } from "./schema-api.js";
export { provision } from "./provision.js";
