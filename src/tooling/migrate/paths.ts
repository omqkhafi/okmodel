/**
 * Config paths resolved against the project directory.
 */

import { resolve } from "node:path";

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
