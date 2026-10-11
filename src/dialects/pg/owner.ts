/**
 * Table ownership marks (`external` and `ignored`).
 *
 * The mark lives on the table value, not in `table()` options. `schema()` does
 * not read it, so a featureless app does not load this module. Tooling stamps
 * the catalog before it plans.
 */

import type { Catalog, CatalogObject, Owner } from "../../contracts/catalog/types.js";
import { OkmError } from "../../contracts/error.js";
import type { AnyTable } from "./table.js";

/** Owners a declaration may set. `managed` stays the default. */
export type DeclaredOwner = Exclude<Owner, "managed">;

const MARKS = new WeakMap<object, DeclaredOwner>();

/**
 * Marks a table `external` or `ignored`.
 *
 * `external` is known and queryable, and a plan never creates, alters, or
 * drops it. `ignored` is invisible to diffs, plans, and `okm check`. The
 * table stays on the schema, so the client can still name it.
 *
 * @param table - A `table()` value
 * @param owner - `external` or `ignored`
 * @returns The same table
 */
export function withOwner<T extends AnyTable>(table: T, owner: DeclaredOwner): T {
  if (owner !== "external" && owner !== "ignored") {
    throw new OkmError("invalid", `Table owner ${String(owner)} is not external or ignored.`, {
      kind: "invalid",
      fix: { summary: "Pass external or ignored. Omit the mark for a managed table." },
    });
  }
  MARKS.set(table, owner);
  return table;
}

/**
 * Reads the mark {@link withOwner} stored.
 *
 * @param table - A table value
 * @returns The mark, or `undefined` when the table is managed
 */
export function tableOwner(table: object): DeclaredOwner | undefined {
  return MARKS.get(table);
}

/**
 * Copies `owner` onto a table and the objects that belong to it.
 *
 * Columns, indexes, constraints, triggers, policies, and sequences that
 * depend on the table follow the table. A catalog with no marks is returned
 * as itself.
 *
 * @param source - Catalog from `schema()`
 * @param marks - SQL table name to owner
 * @returns The catalog planning and drift should read
 */
export function stampOwnership(
  source: Catalog,
  marks: ReadonlyMap<string, DeclaredOwner>,
): Catalog {
  if (marks.size === 0) return source;
  let changed = false;
  const objects = source.objects.map((object) => {
    const owner = ownerFor(object, marks);
    if (owner === undefined || object.owner === owner) return object;
    changed = true;
    return { ...object, owner };
  });
  if (!changed) return source;
  return { version: source.version, objects };
}

function ownerFor(
  object: CatalogObject,
  marks: ReadonlyMap<string, DeclaredOwner>,
): DeclaredOwner | undefined {
  if (object.kind === "table") return marks.get(object.identity.name);
  if (
    object.kind === "column" ||
    object.kind === "index" ||
    object.kind === "constraint" ||
    object.kind === "trigger" ||
    object.kind === "policy"
  ) {
    return marks.get(object.identity.parent.name);
  }
  if (object.kind === "sequence") {
    for (const edge of object.dependencies) {
      if (edge.target.kind !== "table") continue;
      const owner = marks.get(edge.target.name);
      if (owner !== undefined) return owner;
    }
  }
  return undefined;
}
