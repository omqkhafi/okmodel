/**
 * `provision(target)` for one configured target (D198).
 *
 * Same rules as `okm migrate apply` on an empty target, including
 * {@link assertTargetPolicy}. A target that is not empty is OKM1851.
 * Tenant registry creation is M5.
 */

import { join } from "node:path";

import { OkmError } from "../../contracts/error.js";
import { applyTarget, backfillTiming } from "./apply.js";
import { loadHeadSnapshot, loadMigrations } from "./files.js";
import { assertTargetPolicy, selectTarget } from "./policy.js";
import { loadBuiltSchema, loadConfig } from "./project.js";
import { readReference } from "./reference.js";

/**
 * Provisions one configured target from the head snapshot.
 *
 * The target must be empty. Reference rows are inserted if missing. History
 * records `provisioned@<migration id>` and no migration step.
 *
 * @param target - Configured target name. `default` is the `database` target
 * @param cwd - Project directory. Defaults to the process working directory
 * @returns The same text `okm migrate apply` prints for that run
 */
export async function provision(target: string, cwd = process.cwd()): Promise<string> {
  const config = await loadConfig(cwd);
  const selected = selectTarget(config, target);
  assertTargetPolicy(selected, "provision");
  const directory = join(cwd, config.migrations ?? "migrations");
  const migrations = loadMigrations(directory);
  const head = loadHeadSnapshot(directory);
  if (head === undefined) {
    throw new OkmError("invalid", "There is no head snapshot to provision.", {
      fix: { summary: "Run okm generate before provision." },
    });
  }
  const built = await loadBuiltSchema(cwd, config);
  const report = await applyTarget({
    url: selected.url,
    target: selected.name,
    protected: selected.protected,
    allowPooler: config.allowPooler === true,
    ...backfillTiming(config.backfill),
    migrations,
    snapshot: {
      catalog: head.catalog,
      migrationId: head.id,
      catalogHash: head.catalogHash,
      reference: readReference(built.tables, built.casing, head.catalog),
      only: true,
    },
    ...(config.roles !== undefined ? { migrationRole: config.roles.migration } : {}),
    lintDirectory: directory,
  });
  if (report.applied.length === 0) return `target ${report.target}\nnothing to apply\n`;
  return `target ${report.target}\n${report.applied.map((id) => `applied ${id}`).join("\n")}\n`;
}
