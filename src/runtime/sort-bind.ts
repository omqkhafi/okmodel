/**
 * Unique index `sortable()` adds.
 *
 * Tenancy has already widened uniques (D168), so this index names the tenant
 * keys itself. The move and insert SQL load later, on the first call.
 */

import { definition } from "../dialects/pg/misuse.js";
import { buildIndex, type AnyTable, type IndexCall } from "../dialects/pg/table.js";

/**
 * Adds the position unique index on tables this trait applies to.
 *
 * A path table is refused: the tenant key is not a column, so the index could
 * not keep two tenants from sharing a position.
 *
 * @param self - The trait object `schema()` stored
 * @param tables - Tables after the tenancy rewrite
 * @param casing - Schema casing
 * @param schemaTraits - Traits from `schema()`, when any were passed
 * @param group - Field that splits the order, when `sortable` was given one
 * @returns Tables with the index on the ones this trait applies to
 */
export function rewriteSortable(
  self: object,
  tables: readonly AnyTable[],
  casing: "snake" | undefined,
  schemaTraits: readonly object[] | undefined,
  group: string | undefined,
): readonly AnyTable[] {
  return tables.map((item) => {
    if (!applies(self, item, schemaTraits)) return item;
    refusePath(item);
    return withIndex(item, casing, schemaTraits, group);
  });
}

function applies(
  self: object,
  item: AnyTable,
  schemaTraits: readonly object[] | undefined,
): boolean {
  const options = item.options as
    | { readonly traits?: readonly object[]; readonly omitDefaults?: unknown }
    | undefined;
  const own = Array.isArray(options?.traits) ? options.traits : [];
  if (own.includes(self)) return true;
  if (options?.omitDefaults !== undefined) return false;
  return schemaTraits?.includes(self) ?? false;
}

function refusePath(item: AnyTable): void {
  const tenancy = (item.options as { readonly tenancy?: unknown } | undefined)?.tenancy;
  if (typeof tenancy === "object" && tenancy !== null && "via" in tenancy) {
    definition(
      `sortable() on ${item.name} does not combine with via(). Position needs the tenant columns on the row.`,
    );
  }
}

type IndexFactory = (
  columns: Readonly<Record<string, { readonly name: string }>>,
) => readonly IndexCall[];

function withIndex(
  item: AnyTable,
  casing: "snake" | undefined,
  schemaTraits: readonly object[] | undefined,
  group: string | undefined,
): AnyTable {
  const options = item.options as
    | {
        readonly indexes?: IndexFactory;
        readonly tenantKeys?: readonly string[];
      }
    | undefined;
  const prior = options?.indexes;
  const tenantKeys = options?.tenantKeys ?? [];
  const fields: string[] = [];
  for (const field of tenantKeys) if (!fields.includes(field)) fields.push(field);
  if (group !== undefined && !fields.includes(group)) fields.push(group);
  fields.push("position");
  const predicate = archivedPredicate(item, casing, schemaTraits);
  const indexes = (
    handles: Readonly<Record<string, { readonly name: string }>>,
  ): readonly IndexCall[] => {
    const calls = prior === undefined ? [] : prior(handles);
    const columns = fields.map((field) => {
      const handle = handles[field];
      if (handle === undefined) {
        definition(`sortable() on ${item.name} needs a column named ${field}.`);
      }
      return handle.name;
    });
    return [...(Array.isArray(calls) ? calls : []), uniqueIndex(columns, predicate)];
  };
  return {
    ...item,
    options: { ...options, indexes },
  };
}

function archivedPredicate(
  item: AnyTable,
  casing: "snake" | undefined,
  schemaTraits: readonly object[] | undefined,
): string | undefined {
  if (!archivable(item, schemaTraits)) return undefined;
  return casing === "snake" ? "(archived_at IS NULL)" : '("archivedAt" IS NULL)';
}

function archivable(item: AnyTable, schemaTraits: readonly object[] | undefined): boolean {
  const options = item.options as
    | { readonly traits?: readonly object[]; readonly omitDefaults?: unknown }
    | undefined;
  const own = Array.isArray(options?.traits) ? options.traits : [];
  for (const trait of own) if (marked(trait)) return true;
  if (options?.omitDefaults !== undefined) return false;
  if (schemaTraits === undefined) return false;
  for (const trait of schemaTraits) if (marked(trait)) return true;
  return false;
}

function marked(value: object): boolean {
  return (value as { readonly "~archive"?: unknown })["~archive"] === true;
}

function uniqueIndex(columns: readonly string[], predicate: string | undefined): IndexCall {
  return buildIndex({ columns, isUnique: true, predicate });
}
