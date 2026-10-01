/**
 * Applies a plan and reads the scratch database back.
 */

import { introspectObjects, type SqlRunner } from "../catalog/introspect.js";
import {
  normalizeIntrospected,
  rebindNamespace,
  type NormalizedObject,
} from "../catalog/normalize.js";
import { type CatalogObject } from "../catalog/object.js";
import { renderCatalog, type NamespaceBinding } from "../catalog/render.js";
import {
  readRewrittenExpressions,
  rewrittenMismatches,
  structuralMismatches,
  type RewrittenExpression,
} from "./equal.js";
import { planMigration, planSql, type MigrationPlan } from "./plan.js";
import { type ColumnRename } from "./diff.js";

/** What a scratch comparison found. */
export type ApplyReport = {
  readonly plan: MigrationPlan;
  readonly structural: readonly string[];
  readonly expressions: readonly string[];
  readonly expectedExpressions: readonly RewrittenExpression[];
  readonly actualExpressions: readonly RewrittenExpression[];
};

/**
 * Applies `before`, plans the path to `after`, applies the plan, and compares
 * the result with `after` applied on its own schema.
 *
 * Both sides are introspected. Equality is structural plus rewritten view and
 * function bodies. Authoring SQL is not compared.
 *
 * @param runner - Connection whose search_path can be changed
 * @param schema - Concrete schema for the migrated side
 * @param before - Catalog A
 * @param after - Catalog B
 * @param bindingsFor - Builds bindings for a concrete schema
 * @param renames - Declared column renames
 * @returns Mismatches. Both lists are empty when the plan lands on B
 */
export async function applyAndCompare(
  runner: SqlRunner,
  schema: string,
  before: readonly CatalogObject[],
  after: readonly CatalogObject[],
  bindingsFor: (schema: string) => readonly NamespaceBinding[],
  renames: readonly ColumnRename[] = [],
): Promise<ApplyReport> {
  const migrated = `${schema}_m`;
  const fresh = `${schema}_f`;
  const plan = planMigration(before, after, bindingsFor(migrated), renames);
  try {
    await runner.exec(`create schema ${migrated}`);
    await runner.exec(`create schema ${fresh}`);
    await runner.exec(`set search_path to ${migrated}`);
    for (const statement of renderCatalog(before, bindingsFor(migrated))) {
      await runner.exec(statement);
    }
    for (const statement of planSql(plan)) await runner.exec(statement);
    await runner.exec(`set search_path to ${fresh}`);
    for (const statement of renderCatalog(after, bindingsFor(fresh))) {
      await runner.exec(statement);
    }
    await runner.exec("set search_path to public");
    const actual = await readNormalized(runner, migrated, bindingsFor(migrated));
    const expected = await readNormalized(runner, fresh, bindingsFor(fresh));
    const actualExpressions = await readRewrittenExpressions(runner, migrated);
    const expectedExpressions = await readRewrittenExpressions(runner, fresh);
    return {
      plan,
      structural: structuralMismatches(expected, actual),
      expressions: rewrittenMismatches(expectedExpressions, actualExpressions),
      expectedExpressions,
      actualExpressions,
    };
  } finally {
    await runner.exec("set search_path to public");
    await runner.exec(`drop schema if exists ${migrated} cascade`);
    await runner.exec(`drop schema if exists ${fresh} cascade`);
  }
}

async function readNormalized(
  runner: SqlRunner,
  schema: string,
  bindings: readonly NamespaceBinding[],
): Promise<readonly NormalizedObject[]> {
  const introspected = await introspectObjects(runner, [schema], []);
  return introspected
    .map((object) => normalizeIntrospected(object))
    .map((object) => rebindNamespace(object, bindings));
}
