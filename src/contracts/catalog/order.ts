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
import type { CatalogObject } from "./types.js";

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
 * OKM1020.
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

  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const item of indexed) {
    dependents.set(item.key, []);
    remaining.set(item.key, 0);
  }

  for (const item of indexed) {
    const seen = new Set<string>();
    for (const edge of item.object.dependencies) {
      const dependency = identityKey(edge.target);
      if (dependency === item.key) {
        catalogError("OKM1020", `${identityLabel(item.object.identity)} depends on itself.`);
      }
      if (!byKey.has(dependency)) {
        catalogError(
          "OKM1020",
          `${identityLabel(item.object.identity)} depends on ${identityLabel(edge.target)}, which is not in the catalog.`,
        );
      }
      if (seen.has(dependency)) {
        continue;
      }
      seen.add(dependency);
      remaining.set(item.key, (remaining.get(item.key) ?? 0) + 1);
      dependents.get(dependency)?.push(item.key);
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

function insertSorted(ready: string[], from: number, key: string): void {
  let index = from;
  while (index < ready.length && compareText(ready[index] ?? "", key) < 0) {
    index += 1;
  }
  ready.splice(index, 0, key);
}
