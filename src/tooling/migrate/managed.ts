/**
 * Tables OKModel owns: `okm_meta`, `okm_history`, `okm_backfill`, and `okm_steps`.
 *
 * Apply creates them. They are not part of the author schema. Plan, push,
 * check, and doctor omit them on both sides, so a diff neither drops them
 * nor creates them. `okm_steps` holds a committed step only while it is in
 * flight or broken.
 */

import type { Catalog, CatalogObject } from "../../contracts/catalog/types.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";

const MANAGED_TABLES: ReadonlySet<string> = new Set([
  "okm_meta",
  "okm_history",
  "okm_backfill",
  "okm_steps",
]);

/**
 * Grants the migration role the writes apply needs on its own tables.
 *
 * `okm_steps` also needs `DELETE`: that row is removed in the transaction
 * that inserts `okm_history`.
 *
 * @param role - Migration role name
 * @returns Statements, in order
 */
export function migrationJournalGrants(role: string): readonly string[] {
  const quoted = quoteIdent(role);
  return [
    `grant select, insert, update on okm_meta, okm_history, okm_backfill, okm_steps to ${quoted}`,
    `grant delete on okm_steps to ${quoted}`,
  ];
}

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
    name === "okm_backfill" ||
    name === "okm_steps" ||
    name.startsWith("okm_meta_") ||
    name.startsWith("okm_history_") ||
    name.startsWith("okm_backfill_") ||
    name.startsWith("okm_steps_")
  );
}
