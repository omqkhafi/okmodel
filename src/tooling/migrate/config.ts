/**
 * Project configuration for `okm`.
 *
 * Exported from `okmodel/migrate`. The runtime entry stays free of tooling.
 */

/** One migration target. A string is the URL. Protection defaults to false. */
export type TargetInput =
  | string
  | {
      readonly url?: string;
      /** Refuses contract, push, and other non-expand work unless `--allow-protected`. */
      readonly protected?: boolean;
    };

import type { RolesInput } from "../../dialects/pg/role/index.js";

/** Paths and targets `okm` reads. */
export type MigrateConfig = {
  /** Module that exports the built schema. */
  readonly schema: string;
  /** Directory of table files. `okm check` reports one that the schema does not import. */
  readonly tables?: string;
  /** Directory of generated SQL. Defaults to `migrations`. */
  readonly migrations?: string;
  /** Build output. Defaults to `.okm`. */
  readonly out?: string;
  /**
   * The one target named `default`.
   *
   * A direct Postgres URL, not a pooler. Use {@link MigrateConfig.targets} when
   * there is more than one.
   */
  readonly database?: TargetInput;
  /** Named targets. Replaces `database`. */
  readonly targets?: Readonly<Record<string, TargetInput>>;
  /** Apply against a known pooler URL. The default refuses those hosts. */
  readonly allowPooler?: boolean;
  /** Milliseconds for `lock_timeout` and `statement_timeout` during apply. */
  readonly timeouts?: {
    readonly lock?: number;
    readonly statement?: number;
  };
  /**
   * Migration role and application role.
   *
   * A name is external unless it is also listed in `managed`. The plan creates
   * a managed role and never drops one.
   */
  readonly roles?: RolesInput;
};

/**
 * Returns the config unchanged.
 *
 * `database` is one target named `default`. `targets` is the named map.
 * Commands that touch a database require `--target` when several exist.
 *
 * @param config - Schema module, directories, and targets
 * @returns The same config
 */
export function defineConfig(config: MigrateConfig): MigrateConfig {
  return config;
}
