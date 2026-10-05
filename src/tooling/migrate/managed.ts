/**
 * Tables OKModel owns: `okm_meta` and `okm_history`.
 *
 * Apply creates them. They are not part of the author schema. Plan, push,
 * check, and doctor omit them on both sides, so a diff neither drops them
 * nor creates them.
 */

import type { Catalog, CatalogObject } from "../../contracts/catalog/types.js";

const MANAGED_TABLES: ReadonlySet<string> = new Set(["okm_meta", "okm_history"]);

/**
 * Removes the migration history tables and the objects that belong to them.
 *
 * A catalog that has neither is returned as itself.
 *
 * @param source - Catalog about to be diffed or diagnosed
 * @returns The catalog without OKModel's own tables
 */
export function omitManagedObjects(source: Catalog): Catalog {
  let dropped = false;
  const objects: CatalogObject[] = [];
  for (const object of source.objects) {
    if (ownedByMigration(object)) {
      dropped = true;
      continue;
    }
    objects.push(object);
  }
  if (!dropped) return source;
  return { version: source.version, objects };
}

function ownedByMigration(object: CatalogObject): boolean {
  switch (object.kind) {
    case "table":
    case "view":
    case "materializedView":
      return MANAGED_TABLES.has(object.identity.name);
    case "column":
    case "index":
    case "constraint":
    case "trigger":
      return MANAGED_TABLES.has(object.identity.parent.name);
    case "sequence":
      return managedSequence(object.identity.name);
    case "grant": {
      const target = object.identity.object;
      if (target.kind === "namespace") return false;
      if (target.kind === "sequence" || target.kind === "function") {
        return managedSequence(target.name);
      }
      return MANAGED_TABLES.has(target.name);
    }
    default:
      return false;
  }
}

function managedSequence(name: string): boolean {
  return (
    name === "okm_meta" ||
    name === "okm_history" ||
    name.startsWith("okm_meta_") ||
    name.startsWith("okm_history_")
  );
}
