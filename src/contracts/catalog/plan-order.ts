/**
 * Planner ordering facts that are not SQL.
 *
 * A unique constraint has to exist before a foreign key that references it.
 * An index of a view is created with the view. An identity sequence is
 * created by its column. Dialects and the planner share these so neither
 * copies the rules.
 */

import { identityKey } from "./identity.js";
import type { Catalog, CatalogObject, ObjectRef, SequenceObject } from "./types.js";

/**
 * Pulls a unique constraint in front of a foreign key that references it.
 *
 * The primary key is created with the table. A foreign key aimed at another
 * unique has to wait for that unique. Create order ties those two by name, so
 * the foreign key can otherwise come first. The planner uses this for creates
 * and for the list it reverses when it drops.
 *
 * @param objects - Create order
 * @returns The same objects, with those uniques moved forward
 */
export function uniqueBeforeForeignKey(
  objects: readonly CatalogObject[],
): readonly CatalogObject[] {
  const uniques = objects.filter(
    (object): object is CatalogObject & { readonly kind: "constraint" } =>
      object.kind === "constraint" && object.definition.constraintKind === "unique",
  );
  if (uniques.length === 0) return objects;
  const emitted = new Set<CatalogObject>();
  const result: CatalogObject[] = [];
  for (const object of objects) {
    if (emitted.has(object)) continue;
    if (object.kind === "constraint" && object.definition.constraintKind === "foreignKey") {
      const target = object.definition.references;
      if (target !== undefined && !coveredByPrimary(objects, target.parent, target.columns)) {
        const columns = target.columns.join("\0");
        for (const unique of uniques) {
          if (emitted.has(unique)) continue;
          if (!sameRef(unique.identity.parent, target.parent)) continue;
          if (unique.definition.columns.join("\0") !== columns) continue;
          result.push(unique);
          emitted.add(unique);
        }
      }
    }
    result.push(object);
    emitted.add(object);
  }
  return result;
}

/**
 * Reports whether an index belongs to a view or a materialized view.
 *
 * Those indexes are created after the view, not with the tables.
 *
 * @param object - Catalog object
 * @returns `true` when an index edge points at a view
 */
export function ownedByView(object: CatalogObject): boolean {
  if (object.kind !== "index") return false;
  return object.dependencies.some(
    (edge) => edge.target.kind === "view" || edge.target.kind === "materializedView",
  );
}

/**
 * Reports whether a sequence is the one an identity column creates.
 *
 * @param sequence - Sequence object
 * @param source - Catalog that may own it
 * @returns `true` when a column depends on the sequence and declares identity
 */
export function identitySequence(sequence: SequenceObject, source: Catalog): boolean {
  const key = identityKey(sequence.identity);
  return source.objects.some((object) => {
    if (object.kind !== "column" || object.definition.identity === undefined) return false;
    return object.dependencies.some((edge) => identityKey(edge.target) === key);
  });
}

function coveredByPrimary(
  objects: readonly CatalogObject[],
  parent: ObjectRef,
  columns: readonly string[],
): boolean {
  const key = columns.join("\0");
  return objects.some(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "primaryKey" &&
      sameRef(object.identity.parent, parent) &&
      object.definition.columns.join("\0") === key,
  );
}

function sameRef(left: ObjectRef, right: ObjectRef): boolean {
  if (left.name !== right.name || left.namespace.form !== right.namespace.form) return false;
  if (left.namespace.form === "static" && right.namespace.form === "static") {
    return left.namespace.name === right.namespace.name;
  }
  return left.namespace.form === "template" && right.namespace.form === "template"
    ? left.namespace.pattern === right.namespace.pattern
    : false;
}
