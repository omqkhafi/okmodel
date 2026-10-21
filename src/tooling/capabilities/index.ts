/**
 * Dialect capability registry.
 *
 * Tooling only. The featureless app does not import this module.
 */

export {
  assertSupported,
  emulationOf,
  formatEmulation,
  gateCoverageProblems,
  registryProblems,
} from "./check.js";
export { collectTestTitles } from "./titles.js";
export { POSTGRES_FEATURES, type PostgresFeature } from "./postgres.js";
export type { CapabilityGate, EmulatedNote, FeatureEntry, Registry, Support } from "./types.js";
export {
  SESSION_SETTINGS,
  assertSessionSettings,
  type SettingScope,
  type SettingsDialect,
} from "./session.js";
export { featuresUsed } from "./used.js";
