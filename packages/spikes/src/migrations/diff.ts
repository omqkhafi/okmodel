/**
 * Diff of two catalogs, keyed by identity.
 *
 * A column rename is a pair only when `renames` declares it. A dropped column
 * and an added column of the same type, with no declaration, is OKM1530.
 */

import { identityKey } from "../catalog/canonical.js";
import { namespaceOf, parentOf, type CatalogObject, type ColumnObject } from "../catalog/object.js";
import { MigrationError } from "./error.js";

/** A declared column rename. The planner does not guess. */
export type ColumnRename = {
  readonly namespace: string;
  readonly parent: string;
  readonly from: string;
  readonly to: string;
};

/** One object that exists on both sides of a diff. */
export type MatchedObject = {
  readonly before: CatalogObject;
  readonly after: CatalogObject;
};

/** Objects to create, drop, and alter. */
export type CatalogDiff = {
  readonly create: readonly CatalogObject[];
  readonly drop: readonly CatalogObject[];
  readonly matched: readonly MatchedObject[];
};

/**
 * Pairs objects by identity, applying declared column renames.
 *
 * @param before - Catalog that is already applied
 * @param after - Catalog the plan must reach
 * @param renames - Declared column renames
 * @returns The diff. Throws OKM1530 when a rename is ambiguous
 */
export function diffCatalog(
  before: readonly CatalogObject[],
  after: readonly CatalogObject[],
  renames: readonly ColumnRename[] = [],
): CatalogDiff {
  assertNoAmbiguousRename(before, after, renames);
  const afterByKey = new Map(after.map((object) => [identityKey(object.identity), object]));
  const claimed = new Set<string>();
  const matched: MatchedObject[] = [];
  const drop: CatalogObject[] = [];
  for (const object of before) {
    const key = mappedKey(object, renames);
    const found = afterByKey.get(key);
    if (found === undefined) {
      drop.push(object);
      continue;
    }
    claimed.add(key);
    matched.push({ before: object, after: found });
  }
  const create = after.filter((object) => !claimed.has(identityKey(object.identity)));
  return { create, drop, matched };
}

/**
 * Identity key of `object` as it appears in the after catalog.
 *
 * @param object - Before object
 * @param renames - Declared column renames
 * @returns Identity key after applying a rename
 */
export function mappedKey(object: CatalogObject, renames: readonly ColumnRename[]): string {
  if (object.kind !== "column") return identityKey(object.identity);
  const namespace = namespaceOf(object.identity)?.name;
  const rename = renames.find(
    (item) =>
      item.namespace === namespace &&
      item.parent === object.identity.parent &&
      item.from === object.identity.name,
  );
  if (rename === undefined) return identityKey(object.identity);
  return identityKey({ ...object.identity, name: rename.to });
}

function assertNoAmbiguousRename(
  before: readonly CatalogObject[],
  after: readonly CatalogObject[],
  renames: readonly ColumnRename[],
): void {
  const afterKeys = new Set(after.map((object) => identityKey(object.identity)));
  const beforeKeys = new Set(before.map((object) => mappedKey(object, renames)));
  const dropped = before.filter(
    (object): object is ColumnObject =>
      object.kind === "column" && !afterKeys.has(mappedKey(object, renames)),
  );
  const added = after.filter(
    (object): object is ColumnObject =>
      object.kind === "column" && !beforeKeys.has(identityKey(object.identity)),
  );
  for (const left of dropped) {
    const right = added.find(
      (column) =>
        column.identity.parent === left.identity.parent &&
        namespaceOf(column.identity)?.name === namespaceOf(left.identity)?.name &&
        column.definition.type === left.definition.type,
    );
    if (right === undefined) continue;
    const parent = parentOf(left.identity) ?? left.identity.parent;
    throw new MigrationError(
      "OKM1530",
      `Ambiguous rename on ${parent}: dropped ${left.identity.name} and added ${right.identity.name}, both ${left.definition.type}. Declare renamedFrom.`,
    );
  }
}
