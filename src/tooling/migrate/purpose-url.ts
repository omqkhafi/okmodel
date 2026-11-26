/**
 * URL for one command purpose.
 *
 * The migration URL is `roles.migration.env` when that entry names a variable.
 * Otherwise the target URL is used. The value is never written to a plan, a
 * log, or JSON.
 */

import { OkmError } from "../../contracts/error.js";
import type { MigrateConfig } from "./config.js";
import type { TargetRecord } from "./policy.js";

/**
 * URL for migrations, doctor, and apply.
 *
 * @param config - Loaded config
 * @param target - Selected target
 * @returns The URL. The caller must not print it
 */
export function migrationUrl(config: MigrateConfig, target: TargetRecord): string {
  const name = config.roles?.migration.env;
  if (name === undefined) return target.url;
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new OkmError("OKM1910", `roles.migration.env ${name} is unset.`, {
      fix: { summary: `Set ${name} to the direct migration URL.` },
    });
  }
  return value;
}
