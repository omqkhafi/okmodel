/**
 * Apply a catalog, read it back, and compare the normal forms.
 */

import { introspectObjects, type SqlRunner } from "./introspect.js";
import {
  diffNormalized,
  normalizeCatalogObject,
  normalizeIntrospected,
  rebindNamespace,
} from "./normalize.js";
import { type CatalogObject } from "./object.js";
import { renderCatalog, type NamespaceBinding } from "./render.js";

/** Result of one scratch-database round trip. */
export type RoundTripReport = {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
  readonly appliedStatements: number;
  readonly introspected: number;
};

/**
 * Applies managed objects and compares the introspection with the catalog.
 *
 * @param objects - Catalog. `external` and `ignored` objects are not applied or expected
 * @param runner - Scratch database
 * @param bindings - Logical namespace to concrete schema
 * @returns Whether the normal forms match
 */
export async function roundTrip(
  objects: readonly CatalogObject[],
  runner: SqlRunner,
  bindings: readonly NamespaceBinding[],
): Promise<RoundTripReport> {
  const statements = renderCatalog(objects, bindings);
  try {
    for (const statement of statements) {
      await runner.exec(statement);
    }
  } catch (error) {
    return failed(`apply: ${messageOf(error)}`, statements.length, 0);
  }
  const schemas = [...new Set(bindings.map((binding) => binding.concrete))];
  const extensions = objects
    .filter((object) => object.kind === "extension" && object.owner === "managed")
    .map((object) => object.identity.name);
  let introspected;
  try {
    introspected = await introspectObjects(runner, schemas, extensions);
  } catch (error) {
    return failed(`introspect: ${messageOf(error)}`, statements.length, 0);
  }
  const expected = objects
    .filter((object) => object.owner === "managed")
    .map((object) => normalizeCatalogObject(object));
  const actual = introspected
    .map((object) => normalizeIntrospected(object))
    .map((object) => rebindNamespace(object, bindings));
  const mismatches = diffNormalized(expected, actual);
  return {
    ok: mismatches.length === 0,
    mismatches,
    appliedStatements: statements.length,
    introspected: actual.length,
  };
}

function failed(message: string, appliedStatements: number, introspected: number): RoundTripReport {
  return { ok: false, mismatches: [message], appliedStatements, introspected };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
