/**
 * Public entry for `okmodel/migrate`.
 *
 * `defineConfig` and its types. The CLI imports planning and apply helpers
 * from their modules, so those names are not exported.
 */

export { defineConfig, type MigrateConfig, type TargetInput } from "./config.js";
