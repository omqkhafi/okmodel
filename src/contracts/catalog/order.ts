/**
 * Dependency order.
 *
 * Create order is a topological order: dependencies first, ties broken by
 * identity key. The comparison is UTF-16 code unit order, not a locale.
 * Each object's identity key is computed once per pass.
 */

import { catalogError } from "../error.js";
import { identityKey, identityLabel } from "./identity.js";
import { compareText } from "./object.js";
import type { CatalogObject, ObjectIdentity, ObjectRef } from "./types.js";

/** One catalog object and the identity key computed for it. */
export type IndexedObject = {
  readonly key: string;
  readonly object: CatalogObject;
};

/**
 * Computes each object's identity key once.
 *
 * A duplicate identity is OKM1023.
 *
 * @param objects - Catalog objects
 * @returns Objects paired with their keys, in input order
 */
export function indexObjects(objects: readonly CatalogObject[]): readonly IndexedObject[] {
  const seen = new Set<string>();
  const indexed: IndexedObject[] = [];
  for (const object of objects) {
    const key = identityKey(object.identity);
    if (seen.has(key)) {
      catalogError("OKM1023", `Duplicate identity for ${identityLabel(object.identity)}.`);
    }
    seen.add(key);
    indexed.push({ key, object });
  }
  return indexed;
}

/**
 * Orders objects so each dependency appears before the object that needs it.
 *
 * A cycle is OKM1026. A self-edge, or a target that is not in `objects`, is
 * OKM1020. A duplicate identity is OKM1023.
 *
 * @param objects - Catalog objects to order
 * @returns Create order
 */
export function dependencyOrder(objects: readonly CatalogObject[]): readonly CatalogObject[] {
  return orderIndexed(indexObjects(objects));
}

/**
 * Topological order of objects whose identity keys are already known.
 *
 * A cycle is OKM1026. A self-edge, or a target that is not in `indexed`, is
 * OKM1020. A generated column also waits for every column of the same table
 * that is not generated. That edge is used only here: it is not stored on
 * the column, so the catalog hash does not change.
 * `indexed` must not contain duplicate keys.
 *
 * @param indexed - Objects paired with identity keys
 * @returns Create order
 */
export function orderIndexed(indexed: readonly IndexedObject[]): readonly CatalogObject[] {
  const byKey = new Map<string, CatalogObject>();
  for (const item of indexed) {
    byKey.set(item.key, item.object);
  }

  const plainByParent = new Map<string, string[]>();
  for (const item of indexed) {
    const object = item.object;
    if (object.kind !== "column" || object.definition.generated !== undefined) continue;
    const parent = parentTableKey(object.identity.parent);
    const list = plainByParent.get(parent);
    if (list === undefined) plainByParent.set(parent, [item.key]);
    else list.push(item.key);
  }

  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const item of indexed) {
    dependents.set(item.key, []);
    remaining.set(item.key, 0);
  }

  for (const item of indexed) {
    const seen = new Set<string>();
    for (const edge of item.object.dependencies) {
      link(item, identityKey(edge.target), edge.target, seen, byKey, dependents, remaining);
    }
    const object = item.object;
    if (object.kind === "column" && object.definition.generated !== undefined) {
      const plain = plainByParent.get(parentTableKey(object.identity.parent));
      if (plain !== undefined) {
        for (const dependency of plain) {
          const target = byKey.get(dependency);
          if (target !== undefined) {
            link(item, dependency, target.identity, seen, byKey, dependents, remaining);
          }
        }
      }
    }
  }

  const ready = indexed.filter((item) => remaining.get(item.key) === 0).map((item) => item.key);
  ready.sort(compareText);
  const ordered: CatalogObject[] = [];
  let cursor = 0;
  while (cursor < ready.length) {
    const key = ready[cursor];
    if (key === undefined) {
      break;
    }
    cursor += 1;
    const object = byKey.get(key);
    if (object === undefined) {
      catalogError("OKM1020", "Dependency order lost an object while sorting.");
    }
    ordered.push(object);
    for (const dependent of dependents.get(key) ?? []) {
      const left = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, left);
      if (left === 0) {
        insertSorted(ready, cursor, dependent);
      }
    }
  }

  if (ordered.length !== byKey.size) {
    catalogError("OKM1026", "Catalog has a dependency cycle.");
  }
  return ordered;
}

/**
 * Identity key of the table that owns `parent`.
 *
 * Columns of one table share that key.
 *
 * @param parent - Column parent
 * @returns The table's identity key
 */
function parentTableKey(parent: ObjectRef): string {
  return identityKey({ kind: "table", namespace: parent.namespace, name: parent.name });
}

/**
 * Records one dependency edge for the sort.
 *
 * A self-edge or a missing target is OKM1020. A repeated target counts once.
 *
 * @param item - The object that depends on `dependency`
 * @param dependency - Identity key of the target
 * @param target - Identity named when the target is missing
 * @param seen - Targets already counted for `item`
 * @param byKey - Objects in this pass
 * @param dependents - Objects waiting on each key
 * @param remaining - Unsatisfied edges left for each object
 */
function link(
  item: IndexedObject,
  dependency: string,
  target: ObjectIdentity,
  seen: Set<string>,
  byKey: ReadonlyMap<string, CatalogObject>,
  dependents: Map<string, string[]>,
  remaining: Map<string, number>,
): void {
  if (dependency === item.key) {
    catalogError("OKM1020", `${identityLabel(item.object.identity)} depends on itself.`);
  }
  if (!byKey.has(dependency)) {
    catalogError(
      "OKM1020",
      `${identityLabel(item.object.identity)} depends on ${identityLabel(target)}, which is not in the catalog.`,
    );
  }
  if (seen.has(dependency)) return;
  seen.add(dependency);
  remaining.set(item.key, (remaining.get(item.key) ?? 0) + 1);
  dependents.get(dependency)?.push(item.key);
}

function insertSorted(ready: string[], from: number, key: string): void {
  let index = from;
  while (index < ready.length && compareText(ready[index] ?? "", key) < 0) {
    index += 1;
  }
  ready.splice(index, 0, key);
}
