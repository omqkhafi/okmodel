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
import { quoteIdent, quoteLiteral } from "../catalog/sql.js";
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
 * Both sides are introspected. Equality is structural plus rewritten view,
 * materialized view, and function bodies. Authoring SQL is not compared.
 * Extensions are database-scoped, so the fresh schema's `CREATE EXTENSION` is
 * applied as `IF NOT EXISTS` after the plan's effect has been checked against
 * `pg_extension`.
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
  const extensionNames = namesOfKind(before, after, "extension");
  const alreadyInstalled = await installedExtensions(runner, extensionNames);
  const plan = planMigration(before, after, bindingsFor(migrated), renames);
  try {
    await runner.exec(`create schema ${migrated}`);
    await runner.exec(`create schema ${fresh}`);
    await runner.exec(`set search_path to ${migrated}`);
    await execStatements(runner, renderCatalog(before, bindingsFor(migrated)), migrated);
    await execStatements(runner, planSql(plan), migrated);
    const extensionProblems = await extensionMismatches(runner, after, extensionNames);
    await runner.exec(`set search_path to ${fresh}`);
    await execStatements(
      runner,
      renderCatalog(after, bindingsFor(fresh)).map(relaxExtension),
      fresh,
    );
    await runner.exec("set search_path to public");
    const actual = await readNormalized(runner, migrated, bindingsFor(migrated));
    const expected = await readNormalized(runner, fresh, bindingsFor(fresh));
    const actualExpressions = await readRewrittenExpressions(runner, migrated);
    const expectedExpressions = await readRewrittenExpressions(runner, fresh);
    return {
      plan,
      structural: [...extensionProblems, ...structuralMismatches(expected, actual)],
      expressions: rewrittenMismatches(expectedExpressions, actualExpressions),
      expectedExpressions,
      actualExpressions,
    };
  } finally {
    await runner.exec("set search_path to public");
    await runner.exec(`drop schema if exists ${migrated} cascade`);
    await runner.exec(`drop schema if exists ${fresh} cascade`);
    for (const name of extensionNames) {
      if (alreadyInstalled.has(name)) continue;
      await runner.exec(`drop extension if exists ${quoteIdent(name)}`);
    }
  }
}

function namesOfKind(
  before: readonly CatalogObject[],
  after: readonly CatalogObject[],
  kind: CatalogObject["kind"],
): readonly string[] {
  const names = new Set<string>();
  for (const object of [...before, ...after]) {
    if (object.kind === kind) names.add(object.identity.name);
  }
  return [...names].sort();
}

/**
 * Rewrites a fresh-catalog `CREATE EXTENSION` so a database-scoped object the
 * plan already installed does not fail the second apply.
 *
 * The plan itself still emits plain `CREATE EXTENSION`.
 *
 * @param sql - One statement from {@link renderCatalog}
 * @returns The statement to run on the fresh schema
 */
async function execStatements(
  runner: SqlRunner,
  statements: readonly string[],
  schema: string,
): Promise<void> {
  for (const statement of statements) {
    if (/^(create|drop) extension\b/i.test(statement)) {
      await runner.exec("set search_path to public");
      await runner.exec(statement);
      await runner.exec(`set search_path to ${schema}`);
      continue;
    }
    await runner.exec(statement);
  }
}

function relaxExtension(sql: string): string {
  return sql.replace(/^create extension /i, "create extension if not exists ");
}

async function installedExtensions(
  runner: SqlRunner,
  names: readonly string[],
): Promise<ReadonlySet<string>> {
  if (names.length === 0) return new Set();
  const list = names.map((name) => quoteLiteral(name)).join(", ");
  const rows = await runner.query(
    `select extname as name from pg_extension where extname in (${list})`,
  );
  return new Set(rows.map((row) => text(row, "name")));
}

async function extensionMismatches(
  runner: SqlRunner,
  after: readonly CatalogObject[],
  names: readonly string[],
): Promise<readonly string[]> {
  if (names.length === 0) return [];
  const wanted = new Set(
    after.filter((object) => object.kind === "extension").map((object) => object.identity.name),
  );
  const present = await installedExtensions(runner, names);
  const problems: string[] = [];
  for (const name of names) {
    const installed = present.has(name);
    const should = wanted.has(name);
    if (installed !== should) {
      problems.push(
        `extension ${name}: expected installed=${String(should)}, got ${String(installed)}`,
      );
    }
  }
  return problems;
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
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
