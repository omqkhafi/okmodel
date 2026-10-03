/**
 * Migration files on disk: SQL from {@link formatPlan} plus the catalog hash.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { catalogHash, parseCatalog } from "../../contracts/catalog/document.js";
import { OkmError } from "../../contracts/error.js";
import { parsePlan, type PlanStep } from "./plan.js";

/** One migration the applier can run and resume. */
export type StoredMigration = {
  readonly id: string;
  readonly catalogHash: string;
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
    const hash = catalogHash(parseCatalog(readFileSync(catalogPath, "utf8")));
    migrations.push({ id, catalogHash: hash, steps: plan.steps });
  }
  return migrations;
}
