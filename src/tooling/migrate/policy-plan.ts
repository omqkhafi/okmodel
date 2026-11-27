/**
 * Row-security enable and force steps for a migration.
 *
 * Generated tenant policies already carry enable and force in their own
 * SQL. This plans the toggle for every other table. The planner file does
 * not import the Postgres dialect.
 */

import type { Catalog, CatalogObject } from "../../contracts/catalog/types.js";
import { isGeneratedPolicy } from "../../contracts/catalog/policy.js";
import { requireLowered } from "../../dialects/ddl.js";
import { ddlStep } from "../../dialects/ddl-step.js";
import { rlsTogglePlan, type RlsState } from "../../dialects/pg/ddl.js";
import type { PlanStep } from "./plan.js";

/**
 * Enable and force steps that the generated policy SQL does not already cover.
 *
 * @param before - Previous catalog objects
 * @param after - Next catalog
 * @param beforeBy - Previous objects by identity
 * @param afterBy - Next objects by identity
 * @param createKeys - Objects this plan creates
 * @param dropKeys - Objects this plan drops
 * @param schema - Schema name
 * @returns The toggle steps
 */
export function rlsToggleSteps(
  before: readonly CatalogObject[],
  after: Catalog,
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
  createKeys: ReadonlySet<string>,
  dropKeys: ReadonlySet<string>,
  schema: string,
): readonly PlanStep[] {
  const tables = new Set<string>();
  for (const object of [...before, ...after.objects]) {
    if (handsOff(object)) continue;
    if (object.kind === "policy") tables.add(object.identity.parent.name);
    if (object.kind === "table" && object.definition.rowSecurity !== undefined) {
      tables.add(object.identity.name);
    }
  }
  const covered = legacyRlsTables(beforeBy, afterBy, createKeys, dropKeys);
  const steps: PlanStep[] = [];
  for (const table of tables) {
    if (covered.has(table)) continue;
    const planned = rlsTogglePlan(
      table,
      schema,
      rlsStateOf(before, table),
      rlsStateOf(after.objects, table),
    );
    for (const item of planned) {
      steps.push(
        ...requireLowered([ddlStep(item.sql, item.kind, "ddl", "ACCESS EXCLUSIVE", true, [table])]),
      );
    }
  }
  return steps;
}

function legacyRlsTables(
  beforeBy: ReadonlyMap<string, CatalogObject>,
  afterBy: ReadonlyMap<string, CatalogObject>,
  createKeys: ReadonlySet<string>,
  dropKeys: ReadonlySet<string>,
): Set<string> {
  const tables = new Set<string>();
  for (const [key, object] of [...beforeBy, ...afterBy]) {
    if (object.kind !== "policy" || !isGeneratedPolicy(object)) continue;
    if (object.definition.command !== "all" || object.definition.force !== true) continue;
    const creating = createKeys.has(key) && afterBy.get(key) === object;
    const dropping = dropKeys.has(key) && beforeBy.get(key) === object;
    if (creating || dropping) tables.add(object.identity.parent.name);
  }
  return tables;
}

function rlsStateOf(objects: readonly CatalogObject[], table: string): RlsState {
  let enable = false;
  let force = false;
  let policies = 0;
  for (const object of objects) {
    if (object.kind !== "policy" || handsOff(object) || object.identity.parent.name !== table) {
      continue;
    }
    policies += 1;
    if (object.definition.disabled !== true) enable = true;
    if (object.definition.force) force = true;
  }
  if (policies > 0) return { enable, force };
  for (const object of objects) {
    if (
      object.kind === "table" &&
      object.identity.name === table &&
      object.definition.rowSecurity
    ) {
      return object.definition.rowSecurity;
    }
  }
  return { enable: false, force: false };
}

function handsOff(object: CatalogObject): boolean {
  return object.owner === "external" || object.owner === "ignored";
}
