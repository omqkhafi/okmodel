/**
 * Dialect capability registry.
 *
 * Tooling only. The featureless app does not import this module.
 */

export { assertSupported, emulationOf, formatEmulation, registryProblems } from "./check.js";
export { collectTestTitles } from "./titles.js";
export { POSTGRES_FEATURES, type PostgresFeature } from "./postgres.js";
export type { CapabilityGate, EmulatedNote, FeatureEntry, Registry, Support } from "./types.js";
export { featuresUsed } from "./used.js";
