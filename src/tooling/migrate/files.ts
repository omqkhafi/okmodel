/**
 * Migration files on disk: SQL from {@link formatPlan} plus the catalog hash.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { catalogHash, parseCatalog, startupCatalog } from "../../contracts/catalog/document.js";
import { OkmError } from "../../contracts/error.js";
import { parsePlan, type PlanStep } from "./plan.js";

/** One migration the applier can run and resume. */
export type StoredMigration = {
  readonly id: string;
  readonly catalogHash: string;
  /**
   * The hash written before D208, which counted roles and grants.
   *
   * Set only when the catalog has them. Apply moves a stored copy of it to
   * {@link StoredMigration.catalogHash}.
   */
  readonly legacyHash?: string;
  readonly steps: readonly PlanStep[];
};

/**
 * Loads `*.sql` migrations and the sibling catalog snapshot.
 *
 * Files are applied in name order. A SQL file without its catalog is refused.
 *
 * @param directory - Migrations directory. Missing means there are none
 * @returns Migrations in apply order
 */
export function loadMigrations(directory: string): readonly StoredMigration[] {
  if (!existsSync(directory)) return [];
  const names = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const migrations: StoredMigration[] = [];
  for (const file of names) {
    const id = file.slice(0, -".sql".length);
    const catalogPath = join(directory, `${id}.catalog.json`);
    if (!existsSync(catalogPath)) {
      throw new OkmError("invalid", `Migration ${id} is missing its catalog snapshot.`, {
        fix: {
          summary: "Generate the migration again so the SQL and the catalog are written together.",
        },
      });
    }
    const plan = parsePlan(readFileSync(join(directory, file), "utf8"));
    const stored = parseCatalog(readFileSync(catalogPath, "utf8"));
    const startup = startupCatalog(stored);
    const hash = catalogHash(startup);
    migrations.push(
      startup === stored
        ? { id, catalogHash: hash, steps: plan.steps }
        : { id, catalogHash: hash, legacyHash: catalogHash(stored), steps: plan.steps },
    );
  }
  return migrations;
}

/**
 * Loads the last migration's catalog, which is the head snapshot.
 *
 * @param directory - Migrations directory
 * @returns The last file, or `undefined` when there are none
 */
export function loadHeadSnapshot(directory: string):
  | {
      readonly id: string;
      readonly catalogHash: string;
      readonly catalog: ReturnType<typeof parseCatalog>;
    }
  | undefined {
  const migrations = loadMigrations(directory);
  const last = migrations.at(-1);
  if (last === undefined) return undefined;
  return {
    id: last.id,
    catalogHash: last.catalogHash,
    catalog: parseCatalog(readFileSync(join(directory, `${last.id}.catalog.json`), "utf8")),
  };
}
