/**
 * Public entry for `okmodel/migrate`.
 *
 * `defineConfig`, its types, `provision`, and `baseline` for one configured
 * target. `describe` and `buildCatalog` are the programmatic schema API.
 * `plan`, `apply`, and `status` match the CLI commands (D298). `baseline`
 * adopts an existing database (D299).
 */

export { defineConfig, type MigrateConfig, type TargetInput } from "./config.js";
export { type LogicalIdentity } from "./export.js";
export {
  buildCatalog,
  describe,
  type RequiredExtension,
  type SchemaDescription,
  type SchemaRequirements,
} from "./schema-api.js";
export { POSTGRES_FEATURES, type PostgresFeature } from "../capabilities/postgres.js";
export type { FeatureEntry, Registry, Support } from "../capabilities/types.js";
export { provision } from "./provision.js";
export {
  apply,
  baseline,
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
export type {
  EnsureHeadResult,
  FleetConfig,
  FleetEvent,
  FleetGroup,
  FleetState,
  FleetTarget,
  FleetTargetEvent,
  FleetTargetSource,
  MaxFailures,
} from "./fleet-config.js";
export type { FleetRunOptions } from "./fleet-engine.js";

import type {
  FleetConfig as FleetConfigValue,
  FleetEvent as FleetEventValue,
} from "./fleet-config.js";
import type { EnsureHeadResult as EnsureHeadResultValue } from "./fleet-config.js";
import type { FleetRunOptions as FleetRunOptionsValue } from "./fleet-engine.js";

/**
 * Applies a fleet. The same engine as `okm migrate apply --fleet`.
 *
 * @param fleet - The `fleet` object from config
 * @param options - Limits, a frozen plan, and per-target flags
 * @yields One event per target, then a summary
 */
export async function* applyFleet(
  fleet: FleetConfigValue,
  options: FleetRunOptionsValue = {},
): AsyncGenerator<FleetEventValue, void, void> {
  const { applyFleet: run } = await import("./fleet-engine.js");
  yield* run(fleet, options);
}

/**
 * Brings one empty or behind database to the head snapshot.
 *
 * @param url - Direct Postgres URL. It is not returned
 * @param options - Project path and apply flags
 * @returns Applied ids and text with the URL removed
 */
export async function ensureHead(
  url: string,
  options: FleetRunOptionsValue = {},
): Promise<EnsureHeadResultValue> {
  const { ensureHead: run } = await import("./fleet-engine.js");
  return run(url, options);
}
