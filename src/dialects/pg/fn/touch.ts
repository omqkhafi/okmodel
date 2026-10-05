/**
 * The trigger and function `timestamps({ enforce: "trigger" })` contributes.
 *
 * One function per updated-column SQL name. One trigger per table. Provenance
 * is the timestamps trait. The body writes `new.<column> = now()`.
 */

import { fitIdentifier } from "../../../contracts/catalog/identifier.js";
import { staticNamespace } from "../../../contracts/catalog/identity.js";
import { functionObject, triggerObject } from "../../../contracts/catalog/routine.js";
import type { CatalogObject, ObjectRef } from "../../../contracts/catalog/types.js";
import { quoteIdent } from "../ddl.js";

/**
 * Catalog records for tables that carry the timestamps trait.
 *
 * @param built - Objects already staged, including columns
 * @returns The function and one trigger per table, or nothing when no table opted in
 */
export function timestampRecords(built: unknown): readonly CatalogObject[] {
  const columns = updatedColumns(built);
  if (columns.length === 0) return [];
  const namespace = staticNamespace("public");
  const byColumn = new Map<string, ObjectRef[]>();
  for (const column of columns) {
    const list = byColumn.get(column.name) ?? [];
    list.push(column.parent);
    byColumn.set(column.name, list);
  }
  const records: CatalogObject[] = [];
  for (const [column, tables] of byColumn) {
    const name = fitIdentifier(`okm_touch_${column}`);
    const present =
      hasFunction(built, name) ||
      records.some((object) => object.kind === "function" && object.identity.name === name);
    if (!present) {
      records.push(
        functionObject({
          namespace,
          name,
          returns: "trigger",
          language: "plpgsql",
          volatility: "volatile",
          body: `begin new.${quoteIdent(column)} = now(); return new; end`,
          provenance: { origin: "trait", name: "timestamps" },
          dependencies: [],
        }),
      );
    }
    for (const parent of tables) {
      const triggerName = fitIdentifier(`${parent.name}_touch`);
      if (hasTrigger(built, parent.name, triggerName)) continue;
      if (
        records.some(
          (object) =>
            object.kind === "trigger" &&
            object.identity.name === triggerName &&
            object.identity.parent.name === parent.name,
        )
      ) {
        continue;
      }
      records.push(
        triggerObject({
          parent,
          name: triggerName,
          timing: "before",
          events: ["update"],
          level: "row",
          calls: { namespace, name, argTypes: [] },
          provenance: { origin: "trait", name: "timestamps" },
        }),
      );
    }
  }
  return records;
}

function updatedColumns(built: unknown): { readonly parent: ObjectRef; readonly name: string }[] {
  if (!Array.isArray(built)) return [];
  const found: { readonly parent: ObjectRef; readonly name: string }[] = [];
  for (const object of built) {
    if (typeof object !== "object" || object === null) continue;
    if (!("kind" in object) || object.kind !== "column") continue;
    if (!("provenance" in object) || !("identity" in object)) continue;
    const provenance = object.provenance;
    const identity = object.identity;
    if (typeof provenance !== "object" || provenance === null) continue;
    if (typeof identity !== "object" || identity === null) continue;
    if (!("origin" in provenance) || provenance.origin !== "trait") continue;
    if (!("name" in provenance) || provenance.name !== "timestamps") continue;
    if (!("name" in identity) || (identity.name !== "updated_at" && identity.name !== "updatedAt"))
      continue;
    if (!("parent" in identity) || typeof identity.parent !== "object" || identity.parent === null)
      continue;
    const parent = identity.parent;
    if (!("name" in parent) || typeof parent.name !== "string") continue;
    if (
      !("namespace" in parent) ||
      typeof parent.namespace !== "object" ||
      parent.namespace === null
    )
      continue;
    const namespace = parent.namespace;
    if (!("form" in namespace) || namespace.form !== "static") continue;
    if (!("name" in namespace) || typeof namespace.name !== "string") continue;
    found.push({
      parent: { namespace: staticNamespace(namespace.name), name: parent.name },
      name: identity.name,
    });
  }
  return found;
}

function hasFunction(built: unknown, name: string): boolean {
  return named(built, "function", name);
}

function hasTrigger(built: unknown, table: string, name: string): boolean {
  if (!Array.isArray(built)) return false;
  return built.some((object) => {
    if (!isNamed(object, "trigger", name)) return false;
    const identity = object.identity;
    return (
      typeof identity === "object" &&
      identity !== null &&
      "parent" in identity &&
      typeof identity.parent === "object" &&
      identity.parent !== null &&
      "name" in identity.parent &&
      identity.parent.name === table
    );
  });
}

function named(built: unknown, kind: string, name: string): boolean {
  if (!Array.isArray(built)) return false;
  return built.some((object) => isNamed(object, kind, name));
}

function isNamed(
  object: unknown,
  kind: string,
  name: string,
): object is { readonly identity: { readonly name: string } } {
  if (typeof object !== "object" || object === null) return false;
  if (!("kind" in object) || object.kind !== kind) return false;
  if (!("identity" in object) || typeof object.identity !== "object" || object.identity === null)
    return false;
  return "name" in object.identity && object.identity.name === name;
}
