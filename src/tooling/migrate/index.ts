/**
 * Public entry for `okmodel/migrate`.
 *
 * `defineConfig`, its types, and `provision` for one configured target.
 * The CLI imports planning and apply helpers from their modules.
 */

export { defineConfig, type MigrateConfig, type TargetInput } from "./config.js";
export { provision } from "./provision.js";
