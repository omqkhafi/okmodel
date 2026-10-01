/**
 * Dependency order.
 *
 * Create order is a deterministic topological order: dependencies first, and
 * ties broken by identity key. Drop order is that sequence reversed. A cycle
 * is an error.
 */

import { identityKey } from "./canonical.js";
import { assertIdentifierFits } from "./identifier.js";
import {
  CatalogError,
  namespaceOf,
  parentOf,
  type CatalogObject,
  type ObjectIdentity,
} from "./object.js";

/** Objects to drop before a change, then create again afterwards. */
export type RecreatePlan = {
  readonly drop: readonly CatalogObject[];
  readonly recreate: readonly CatalogObject[];
};

/**
 * Checks identity, name length, and that every dependency target exists.
 *
 * `partial` skips the dependency-existence check so a planner can render one
 * object whose dependencies are already in the database.
 *
 * @param objects - Catalog objects
 * @param options - Set `partial` to allow missing dependency targets
 */
export function assertCatalog(
  objects: readonly CatalogObject[],
  options?: { readonly partial?: boolean },
): void {
  const keys = new Set<string>();
  for (const object of objects) {
    if (object.kind !== object.identity.kind) {
      throw new CatalogError(
        `${object.identity.name} has kind ${object.kind} and identity kind ${object.identity.kind}.`,
      );
    }
    const key = identityKey(object.identity);
    if (keys.has(key)) throw new CatalogError(`Duplicate identity ${key}.`);
    keys.add(key);
    assertIdentifierFits(object.identity.name, object.kind);
    const parent = parentOf(object.identity);
    if (parent !== undefined) assertIdentifierFits(parent, `${object.kind} parent`);
    const namespace = namespaceOf(object.identity);
    if (namespace !== undefined && !namespace.template) {
      assertIdentifierFits(namespace.name, "namespace");
    }
    if (object.kind === "function") {
      const types = object.definition.args.map((arg) => arg.type);
      if (types.join(",") !== object.identity.argTypes.join(",")) {
        throw new CatalogError(
          `Function ${object.identity.name} argument types do not match its identity.`,
        );
      }
    }
  }
  if (options?.partial === true) return;
  for (const object of objects) {
    for (const edge of object.dependencies) {
      if (!keys.has(identityKey(edge.identity))) {
        throw new CatalogError(
          `${object.identity.name} depends on ${edge.identity.name}, which is not in the catalog.`,
        );
      }
    }
  }
}

/**
 * Orders objects so each dependency appears before the object that needs it.
 *
 * A dependency that is not in `objects` is treated as already present.
 *
 * @param objects - Catalog objects to order
 * @returns Create order
 */
export function creationOrder(objects: readonly CatalogObject[]): readonly CatalogObject[] {
  return topo(objects);
}

/**
 * Reverse of {@link creationOrder}.
 *
 * @param objects - Catalog objects to order
 * @returns Drop order
 */
export function dropOrder(objects: readonly CatalogObject[]): readonly CatalogObject[] {
  return [...creationOrder(objects)].reverse();
}

/**
 * Plans a drop and recreate around a changed object or one of its columns.
 *
 * Changing a table also recreates dependents of its columns. Changing a column
 * recreates only dependents of that column. The changed object itself stays.
 *
 * @param objects - Catalog
 * @param changed - Object that will be altered
 * @returns Dependents to drop, then create again
 */
export function recreatePlan(
  objects: readonly CatalogObject[],
  changed: ObjectIdentity,
): RecreatePlan {
  const changedKey = identityKey(changed);
  const keys = new Set<string>([changedKey]);
  if (changed.kind === "table") {
    for (const object of objects) {
      if (object.kind === "column" && object.identity.parent === changed.name) {
        const namespace = namespaceOf(object.identity);
        const changedNamespace = namespaceOf(changed);
        if (namespace?.name === changedNamespace?.name) keys.add(identityKey(object.identity));
      }
    }
  }
  const dropKeys = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const object of objects) {
      const key = identityKey(object.identity);
      if (dropKeys.has(key) || keys.has(key)) continue;
      const hits = object.dependencies.some(
        (edge) => keys.has(identityKey(edge.identity)) || dropKeys.has(identityKey(edge.identity)),
      );
      if (!hits) continue;
      dropKeys.add(key);
      grew = true;
    }
  }
  const selected = objects.filter((object) => dropKeys.has(identityKey(object.identity)));
  const create = creationOrder(selected);
  return { drop: [...create].reverse(), recreate: create };
}

function topo(objects: readonly CatalogObject[]): readonly CatalogObject[] {
  const byKey = new Map<string, CatalogObject>();
  for (const object of objects) {
    const key = identityKey(object.identity);
    if (byKey.has(key)) throw new CatalogError(`Duplicate identity ${key}.`);
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
      const dependency = identityKey(edge.identity);
      if (dependency === key) throw new CatalogError(`${object.identity.name} depends on itself.`);
      if (!byKey.has(dependency) || seen.has(dependency)) continue;
      seen.add(dependency);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
      dependents.get(dependency)?.push(key);
    }
  }
  const ready = [...byKey.keys()].filter((key) => remaining.get(key) === 0).sort();
  const ordered: CatalogObject[] = [];
  while (ready.length > 0) {
    const key = ready.shift();
    if (key === undefined) break;
    const object = byKey.get(key);
    if (object === undefined) throw new CatalogError(`Missing object ${key}.`);
    ordered.push(object);
    for (const dependent of dependents.get(key) ?? []) {
      const left = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, left);
      if (left === 0) insertSorted(ready, dependent);
    }
  }
  if (ordered.length !== byKey.size) {
    throw new CatalogError("Dependency cycle.");
  }
  return ordered;
}

function insertSorted(ready: string[], key: string): void {
  let index = 0;
  while (index < ready.length && (ready[index] ?? "") < key) index += 1;
  ready.splice(index, 0, key);
}
