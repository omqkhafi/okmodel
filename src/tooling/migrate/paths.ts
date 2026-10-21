/**
 * Config paths resolved against the project directory.
 */

import { dirname, resolve } from "node:path";

import { resolveProject } from "./discover.js";

/** Default config file name the loader reads (D296, D298). */
export const CONFIG_FILE = "okmodel.config.ts";

/**
 * Project directory and the absolute config path to load.
 *
 * When `config` is set, the project root is that file's directory so schema
 * and migrations paths stay next to the config (monorepo package or absolute
 * `--config`). With no `config`, {@link resolveProject} picks the nearest
 * `okmodel.config.ts`. `ambiguous` is set when two files are equally near.
 */
export type ProjectContext = {
  readonly cwd: string;
  readonly configPath: string;
  /** Config files at the same distance. The loader refuses to pick one. */
  readonly ambiguous?: readonly string[];
};

/**
 * Resolves a config path against `cwd`.
 *
 * An absolute segment stays absolute. A relative segment, including `..`,
 * is resolved from `cwd`.
 *
 * @param cwd - Project directory
 * @param parts - `schema`, `tables`, `migrations`, `out`, a seed file, or a child
 * @returns An absolute path
 */
export function projectPath(cwd: string, ...parts: readonly string[]): string {
  return resolve(cwd, ...parts);
}

/**
 * Builds a {@link ProjectContext} from a working directory and optional config.
 *
 * @param cwd - Directory used when `config` is omitted, or as the base for a
 *   relative `--config` path
 * @param config - Path from `--config` / programmatic `config`. Absolute or
 *   relative to `cwd`
 * @returns Project root and absolute config path
 */
export function projectContext(cwd: string, config?: string): ProjectContext {
  if (config !== undefined) {
    const configPath = resolve(cwd, config);
    return { cwd: dirname(configPath), configPath };
  }
  return resolveProject(cwd, CONFIG_FILE);
}

/**
 * Normalises a project argument to a {@link ProjectContext}.
 *
 * @param project - Working directory or an explicit context
 * @returns Project root and config path
 */
export function asProject(project: string | ProjectContext): ProjectContext {
  return typeof project === "string" ? projectContext(project) : project;
}
