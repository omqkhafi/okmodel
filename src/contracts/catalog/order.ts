/**
 * Dependency order.
 *
 * Create order is a topological order: dependencies first, ties broken by
 * identity key. The comparison is UTF-16 code unit order, not a locale.
 */

import { catalogError } from "../error.js";
import { compareText } from "./object.js";
import { identityKey, identityLabel } from "./identity.js";
import type { CatalogObject } from "./types.js";

/**
 * Orders objects so each dependency appears before the object that needs it.
 *
 * A cycle, a self-edge, or a target that is not in `objects` is OKM1020.
 * Draft 18 does not assign a separate code to a cycle.
 *
 * @param objects - Catalog objects to order
 * @returns Create order
 */
export function dependencyOrder(objects: readonly CatalogObject[]): readonly CatalogObject[] {
  const byKey = new Map<string, CatalogObject>();
  for (const object of objects) {
    const key = identityKey(object.identity);
    if (byKey.has(key)) {
      catalogError("OKM1023", `Duplicate identity for ${identityLabel(object.identity)}.`);
    }
    byKey.set(key, object);
  }

  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const key of byKey.keys()) {
    dependents.set(key, []);
    remaining.set(key, 0);
  }

  for (const object of objects) {
    const key = identityKey(object.identity);
    const seen = new Set<string>();
    for (const edge of object.dependencies) {
      const dependency = identityKey(edge.target);
      if (dependency === key) {
        catalogError("OKM1020", `${identityLabel(object.identity)} depends on itself.`);
      }
      if (!byKey.has(dependency)) {
        catalogError(
          "OKM1020",
          `${identityLabel(object.identity)} depends on ${identityLabel(edge.target)}, which is not in the catalog.`,
        );
      }
      if (seen.has(dependency)) {
        continue;
      }
      seen.add(dependency);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
      dependents.get(dependency)?.push(key);
    }
  }

  const ready = [...byKey.keys()].filter((key) => remaining.get(key) === 0).sort(compareText);
  const ordered: CatalogObject[] = [];
  while (ready.length > 0) {
    const key = ready.shift();
    if (key === undefined) {
      break;
    }
    const object = byKey.get(key);
    if (object === undefined) {
      catalogError("OKM1020", "Dependency order is missing an object.");
    }
    ordered.push(object);
    for (const dependent of dependents.get(key) ?? []) {
      const left = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, left);
      if (left === 0) {
        insertSorted(ready, dependent);
      }
    }
  }

  if (ordered.length !== byKey.size) {
    catalogError("OKM1020", "Dependency cycle.");
  }
  return ordered;
}

function insertSorted(ready: string[], key: string): void {
  let index = 0;
  while (index < ready.length && compareText(ready[index] ?? "", key) < 0) {
    index += 1;
  }
  ready.splice(index, 0, key);
}
