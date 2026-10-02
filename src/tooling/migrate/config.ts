/**
 * Project configuration for `okm`.
 *
 * Exported from `okmodel/migrate`. The runtime entry stays free of tooling.
 */

/** Paths `okm build`, `okm generate`, and `okm check` read. */
export type MigrateConfig = {
  /** Module that exports the built schema. */
  readonly schema: string;
  /** Directory of table files. `okm check` reports one that the schema does not import. */
  readonly tables?: string;
  /** Directory of generated SQL. Defaults to `migrations`. */
  readonly migrations?: string;
  /** Build output. Defaults to `.okm`. */
  readonly out?: string;
};

/**
 * Returns the config unchanged.
 *
 * Targets and the migration role arrive with apply (P16B). This prompt only
 * needs the schema and the directories the planner writes.
 *
 * @param config - Schema module and output directories
 * @returns The same config
 */
export function defineConfig(config: MigrateConfig): MigrateConfig {
  return config;
}
