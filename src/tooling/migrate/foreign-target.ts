/**
 * Foreign-key target check for plan, check, and apply.
 *
 * The referenced columns must equal a primary key, a unique constraint, or a
 * non-partial unique index. `schema()` does not connect and does not run this.
 */

import type { Catalog, CatalogObject } from "../../contracts/catalog/types.js";
import { OkmError } from "../../contracts/error.js";

/**
 * Refuses a foreign key whose target is not a key.
 *
 * @param catalog - The schema catalog, after generated expressions are sealed
 * @throws OkmError OKM1921 when the target is not a primary key, unique constraint, or non-partial unique index
 */
export function assertForeignKeyTargets(catalog: Catalog): void {
  const keys = targetKeys(catalog);
  for (const object of catalog.objects) {
    if (object.kind !== "constraint" || object.definition.constraintKind !== "foreignKey") continue;
    const references = object.definition.references;
    if (references === undefined) continue;
    refuseDeferrableRestrict(object);
    const wanted = [...references.columns].sort().join("\0");
    const parent = references.parent.name;
    const hit = keys.get(`${parent}\0${wanted}`);
    if (hit === "key") continue;
    const name = `${object.identity.parent.name}.${object.identity.name}`;
    const message =
      hit === "partial"
        ? `Foreign key ${name} references a partial unique index on ${parent}. A partial index is not a foreign-key target.`
        : `Foreign key ${name} must reference a primary key, a unique constraint, or a non-partial unique index on ${parent}.`;
    throw new OkmError("OKM1921", message, { fix: { summary: message } });
  }
}

function refuseDeferrableRestrict(object: Extract<CatalogObject, { kind: "constraint" }>): void {
  if (!object.definition.deferrable) return;
  const references = object.definition.references;
  if (references?.onDelete !== "restrict" && references?.onUpdate !== "restrict") return;
  const message = "RESTRICT is never deferred. Use noAction.";
  throw new OkmError("OKM1920", message, { fix: { summary: message } });
}

function targetKeys(catalog: Catalog): Map<string, "key" | "partial"> {
  const keys = new Map<string, "key" | "partial">();
  const mark = (parent: string, columns: readonly string[], kind: "key" | "partial"): void => {
    const id = `${parent}\0${[...columns].sort().join("\0")}`;
    if (keys.get(id) === "key") return;
    keys.set(id, kind);
  };
  for (const object of catalog.objects) {
    if (object.kind === "constraint") {
      const kind = object.definition.constraintKind;
      if (kind === "primaryKey" || kind === "unique") {
        mark(object.identity.parent.name, object.definition.columns, "key");
      }
    }
    if (
      object.kind === "index" &&
      object.definition.unique &&
      object.definition.columns.length > 0
    ) {
      mark(
        object.identity.parent.name,
        object.definition.columns,
        object.definition.predicate === undefined ? "key" : "partial",
      );
    }
  }
  return keys;
}
