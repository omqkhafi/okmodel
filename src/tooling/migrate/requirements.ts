/**
 * Schema requirements `describe()` reports (D300).
 *
 * `minPostgres` is the lowest major that supports every feature the schema
 * uses, at least the project floor. Extensions are the ones the catalog
 * declares or that a column, index, or function depends on, each with the
 * reason it is needed. This module is tooling. It does not enter the runtime
 * entry.
 */

import type { Catalog, CatalogObject } from "../../contracts/catalog/types.js";
import {
  parsePostgresFloor,
  POSTGRES_FLOOR,
  UUIDV7_POSTGRES,
  type PostgresMajor,
} from "../../dialects/pg/floor.js";
import { EXT_PACKS } from "../../dialects/pg/ext/versions.js";

/**
 * One extension the schema needs.
 *
 * `name` is the extension. `reason` says why, in catalog order.
 */
export type RequiredExtension = {
  readonly name: string;
  readonly reason: string;
};

/**
 * Reads the floor a schema stored, or the project floor when none was stored.
 *
 * @param requires - `schema().requires`, when the caller has the schema result
 * @returns The declared major, or {@link POSTGRES_FLOOR}
 */
export function declaredFloor(requires: { readonly postgres?: string } | undefined): PostgresMajor {
  const parsed = parsePostgresFloor(requires?.postgres);
  if (parsed === 15 || parsed === 16 || parsed === 17 || parsed === 18) return parsed;
  return POSTGRES_FLOOR;
}

/**
 * Lowest major that supports every feature the catalog uses.
 *
 * A `uuidv7()` default raises the floor to 18. A declared floor that is
 * already higher stays. Anything else is the project floor.
 *
 * @param catalog - Catalog `schema()` built
 * @param declared - Floor `schema({ minPostgres })` stored, or the project floor
 * @returns 15, 16, 17, or 18
 */
export function schemaMinPostgres(catalog: Catalog, declared: PostgresMajor): PostgresMajor {
  let floor = declared;
  if (usesUuidV7(catalog) && floor < UUIDV7_POSTGRES) floor = UUIDV7_POSTGRES;
  return floor;
}

/**
 * Extensions the catalog needs, with one reason each.
 *
 * A declaration is `extension(name)`. A column, index, or function that
 * depends on an extension names that object. The same name appears once.
 * The reason joins every use, in catalog order.
 *
 * @param catalog - Catalog `schema()` built
 * @returns Extensions sorted by name
 */
export function requiredExtensions(catalog: Catalog): readonly RequiredExtension[] {
  const reasons = new Map<string, string[]>();
  const opclassOwner = opclassExtensions();
  for (const object of catalog.objects) {
    if (object.kind === "extension") {
      pushReason(reasons, object.identity.name, `extension(${object.identity.name})`);
    }
    for (const edge of object.dependencies) {
      if (edge.target.kind !== "extension") continue;
      pushReason(reasons, edge.target.name, useReason(object));
    }
    if (object.kind === "index" && object.definition.expression !== undefined) {
      for (const opclass of opclassOf(object.definition.expression)) {
        const owner = opclassOwner.get(opclass);
        if (owner === undefined) continue;
        pushReason(
          reasons,
          owner,
          `index ${object.identity.parent.name}.${object.identity.name} uses ${owner}`,
        );
      }
    }
  }
  return [...reasons.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([name, uses]) => ({ name, reason: unique(uses).join("; ") }));
}

function usesUuidV7(catalog: Catalog): boolean {
  for (const object of catalog.objects) {
    if (object.kind === "column" && object.definition.defaultExpression === "uuidv7()") {
      return true;
    }
  }
  return false;
}

function useReason(object: CatalogObject): string {
  if (object.kind === "column") {
    return `column ${object.identity.parent.name}.${object.identity.name}`;
  }
  if (object.kind === "index") {
    return `index ${object.identity.parent.name}.${object.identity.name}`;
  }
  if (object.kind === "function") {
    return `function ${object.identity.name}`;
  }
  if ("name" in object.identity && typeof object.identity.name === "string") {
    return `${object.kind} ${object.identity.name}`;
  }
  return object.kind;
}

function opclassExtensions(): ReadonlyMap<string, string> {
  const owners = new Map<string, string>([
    // Hand-written packs are not in EXT_PACKS (D281 keeps vector out too).
    ["gin_trgm_ops", "pg_trgm"],
    ["gist_trgm_ops", "pg_trgm"],
  ]);
  for (const pack of EXT_PACKS) {
    for (const signature of pack.signatures) {
      if (signature.kind === "opclass") owners.set(signature.name, pack.name);
    }
  }
  return owners;
}

/**
 * Every `*_ops` token in an index `using` tail, lowercased.
 *
 * A multi-column index may list several operator classes. The first token
 * can be a built-in class (`text_pattern_ops`); later tokens still need a
 * pack. Matching is case-insensitive so `GIN_TRGM_OPS` is the same as
 * `gin_trgm_ops`.
 *
 * @param expression - Catalog index expression
 * @returns Operator class names in left-to-right order
 */
function opclassOf(expression: string): readonly string[] {
  const names: string[] = [];
  for (const match of expression.matchAll(/\b([a-z_][a-z0-9_]*_ops)\b/gi)) {
    const name = match[1];
    if (name !== undefined) names.push(name.toLowerCase());
  }
  return names;
}

function pushReason(reasons: Map<string, string[]>, name: string, reason: string): void {
  const list = reasons.get(name);
  if (list === undefined) reasons.set(name, [reason]);
  else list.push(reason);
}

function unique(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
