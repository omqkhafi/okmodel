/**
 * What "equal" means for a catalog diff.
 *
 * Structural equality is the normalised object: kind, identity, types,
 * nullability, flags, partition bounds, and expressions Postgres can reprint
 * (`pg_get_expr` for defaults, checks, generated columns, index expressions,
 * domain checks). Owner, provenance, and authoring SQL are not part of it.
 *
 * View bodies and function bodies are not in that structure. P03 showed the
 * server rewrites them, so source text cannot be the hashed form. Those two
 * are equal only when a scratch database reprints them the same way.
 */

import { canonicalJson, identityKey, sha256, type Json } from "../catalog/canonical.js";
import { type SqlRunner } from "../catalog/introspect.js";
import {
  diffNormalized,
  normalizeCatalogObject,
  normalizedKey,
  type NormalizedObject,
} from "../catalog/normalize.js";
import { type CatalogObject } from "../catalog/object.js";
import { quoteLiteral } from "../catalog/sql.js";

/** One expression read back from Postgres. */
export type RewrittenExpression = {
  readonly key: string;
  readonly expr: string;
};

/**
 * Structural drift hash.
 *
 * The digest covers normalised attributes and declared dependency keys. It
 * does not cover view SQL or function bodies. Object order does not matter.
 *
 * @param objects - Catalog objects
 * @returns SHA-256 hex
 */
export function structuralDriftHash(objects: readonly CatalogObject[]): string {
  const parts = objects
    .filter((object) => object.owner === "managed")
    .map((object) => structuralPart(normalizeCatalogObject(object), dependencyKeys(object)))
    .sort();
  return sha256(parts.join("\n"));
}

/**
 * Structural drift hash of an introspection.
 *
 * Dependencies are omitted: the database does not store plpgsql edges, and
 * this hash is the fast path over the normalised structure alone.
 *
 * @param objects - Normalised rows
 * @returns SHA-256 hex
 */
export function introspectedDriftHash(objects: readonly NormalizedObject[]): string {
  const parts = objects.map((object) => structuralPart(object, [])).sort();
  return sha256(parts.join("\n"));
}

/**
 * Hash of scratch-database expression text.
 *
 * Equal rewrites hash equal. A real change in a view or function body changes
 * the hash. Schema names must already have been scrubbed.
 *
 * @param expressions - Read-backs
 * @returns SHA-256 hex
 */
export function rewrittenDriftHash(expressions: readonly RewrittenExpression[]): string {
  const parts = expressions.map((item) => `${item.key}=${collapse(item.expr)}`).sort();
  return sha256(parts.join("\n"));
}

/**
 * Structural mismatches between two normalised catalogs.
 *
 * @param expected - Target
 * @param actual - What the database has
 * @returns Empty when the structures match
 */
export function structuralMismatches(
  expected: readonly NormalizedObject[],
  actual: readonly NormalizedObject[],
): readonly string[] {
  return diffNormalized(expected, actual);
}

/**
 * Reads view and function bodies as Postgres reprints them.
 *
 * @param runner - Scratch database
 * @param schema - Concrete schema
 * @returns One row per view and function, with the schema name replaced
 */
export async function readRewrittenExpressions(
  runner: SqlRunner,
  schema: string,
): Promise<readonly RewrittenExpression[]> {
  const literal = quoteLiteral(schema);
  const rows = await runner.query(`
    select 'view:' || c.relname as key, pg_get_viewdef(c.oid, true) as expr
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${literal} and c.relkind = 'v'
    union all
    select 'function:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           pg_get_functiondef(p.oid)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = ${literal} and p.prokind = 'f'
  `);
  return rows.map((row) => ({
    key: text(row, "key"),
    expr: scrubSchema(text(row, "expr"), schema),
  }));
}

/**
 * Compares scratch read-backs.
 *
 * Whitespace is collapsed. The concrete schema name is not part of the
 * comparison.
 *
 * @param expected - Read-back of the target catalog
 * @param actual - Read-back after the plan
 * @returns Mismatches. Empty when the reprints match
 */
export function rewrittenMismatches(
  expected: readonly RewrittenExpression[],
  actual: readonly RewrittenExpression[],
): readonly string[] {
  const actualByKey = new Map(actual.map((item) => [item.key, collapse(item.expr)]));
  const expectedKeys = new Set(expected.map((item) => item.key));
  const problems: string[] = [];
  for (const item of expected) {
    const found = actualByKey.get(item.key);
    if (found === undefined) {
      problems.push(`missing expression ${item.key}`);
      continue;
    }
    if (found !== collapse(item.expr)) {
      problems.push(`expression ${item.key}: expected ${collapse(item.expr)}, got ${found}`);
    }
  }
  for (const item of actual) {
    if (!expectedKeys.has(item.key)) problems.push(`extra expression ${item.key}`);
  }
  return problems;
}

/**
 * Replaces a concrete schema name so two scratch databases can be compared.
 *
 * @param expression - SQL text from the server
 * @param schema - Concrete schema to erase
 * @returns Text that uses `ns` in place of that schema
 */
export function scrubSchema(expression: string, schema: string): string {
  return expression.replaceAll(`"${schema}"`, '"ns"').replaceAll(schema, "ns");
}

function structuralPart(object: NormalizedObject, dependencies: readonly string[]): string {
  const attributes: Json = object.attributes;
  const json: Json = {
    argTypes: object.argTypes,
    attributes,
    dependencies,
    key: normalizedKey(object),
    kind: object.kind,
  };
  return canonicalJson(json);
}

function dependencyKeys(object: CatalogObject): readonly string[] {
  return object.dependencies.map((edge) => identityKey(edge.identity)).sort();
}

function collapse(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}
