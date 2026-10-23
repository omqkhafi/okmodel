/**
 * Cascade checks and partial uniques for `archivable()`.
 *
 * The trait calls this from the schema rewrite, after tenancy widens uniques.
 * `schema()` does not import it.
 */

import { catalogError, OkmError, throwNamed } from "../../contracts/error.js";
import { compareText } from "../../contracts/catalog/object.js";
import { ColumnBuilder, retarget, type ReferenceModifier } from "./column.js";
import type { ArchiveLink, ArchiveModel } from "./model.js";
import { printedIdentifier } from "../../contracts/catalog/identifier.js";
import type { Names } from "./casing.js";
import { buildIndex, type AnyTable, type IndexCall } from "./table.js";
import { pathEndpoint } from "./path-endpoint.js";

type TableOptions = {
  readonly sqlName?: string;
  readonly unique?: Readonly<Record<string, readonly string[]>>;
  readonly primaryKey?: readonly string[];
  readonly indexes?: (
    columns: Readonly<Record<string, { readonly name: string }>>,
  ) => readonly IndexCall[];
  readonly traits?: readonly object[];
  readonly omitDefaults?: unknown;
};

type Edge = {
  readonly from: string;
  readonly field: string;
  readonly to: string;
  readonly local: readonly string[];
  readonly remote: readonly string[];
};

/**
 * Makes an archivable table's uniques partial and checks its cascade.
 *
 * Tenancy has already widened uniques. This pass turns those lists into
 * unique indexes filtered on `archived_at is null`, and stores the cascade
 * links the planner reads.
 *
 * @param self - The trait object on the table or the schema
 * @param tables - Tables after the tenancy rewrite
 * @param names - Name lookups for the schema
 * @param schemaTraits - Traits from `schema()`, when any were passed
 * @param cascade - Child tables named on this trait
 * @returns Tables with partial uniques and an archive model where this trait applies
 */
export function rewriteArchivable(
  self: object,
  tables: readonly AnyTable[],
  names: Names,
  schemaTraits: readonly object[] | undefined,
  cascade: readonly string[],
): readonly AnyTable[] {
  const byName = new Map(tables.map((item) => [item.name, item]));
  const accepted = tables.map((item) => item.name);
  const edges = foreignKeys(tables, names, byName);
  const { at: archiveSql, id: idSql, predicate } = archiveNames(names);
  return tables.map((item) => {
    if (!applies(self, item, schemaTraits)) return item;
    return rewriteOne(
      item,
      cascade,
      byName,
      accepted,
      edges,
      names,
      schemaTraits,
      archiveSql,
      idSql,
      predicate,
    );
  });
}

function rewriteOne(
  item: AnyTable,
  cascade: readonly string[],
  byName: ReadonlyMap<string, AnyTable>,
  accepted: readonly string[],
  edges: readonly Edge[],
  names: Names,
  schemaTraits: readonly object[] | undefined,
  archiveSql: string,
  idSql: string,
  predicate: string,
): AnyTable {
  if (Object.hasOwn(item, pathEndpoint)) {
    throw new OkmError(
      "OKM1705",
      `Table ${item.name} is the end of a path and cannot be archivable().`,
      { fix: { summary: `Leave ${item.name} out of archivable().` } },
    );
  }
  const links = childLinks(
    item,
    cascade,
    byName,
    accepted,
    edges,
    names,
    schemaTraits,
    archiveSql,
    idSql,
  );
  const parents = parentLinks(item, byName, edges, names, schemaTraits, archiveSql, idSql);
  const primary = primaryFields(item);
  if ((links.length > 0 || parents.length > 0) && primary.length === 0) {
    catalogError("OKM1020", `Table ${item.name} is archivable and needs a primary key.`);
  }
  const options = item.options as TableOptions | undefined;
  const partials: IndexCall[] = [];
  const named = options?.unique;
  if (named !== undefined) {
    for (const fields of Object.values(named)) {
      partials.push(
        partialIndex(
          fields.map((field) => names.column(item, field)),
          predicate,
        ),
      );
    }
  }
  let columns: Record<string, object> | undefined;
  for (const [field, builder] of Object.entries(item.columns)) {
    if (!(builder instanceof ColumnBuilder) || builder.state.unique === undefined) continue;
    columns ??= { ...item.columns };
    columns[field] = retarget(builder, { dropUnique: true });
    partials.push(partialIndex([names.column(item, field)], predicate));
  }
  const prior = options?.indexes;
  const indexes =
    partials.length === 0
      ? undefined
      : (handles: Readonly<Record<string, { readonly name: string }>>) => {
          const calls = prior === undefined ? [] : prior(handles);
          return [...partials, ...(Array.isArray(calls) ? calls : [])];
        };
  const archiveModel: ArchiveModel = {
    at: archiveSql,
    id: idSql,
    atField: "archivedAt",
    idField: "archiveId",
    cascade: links,
    parents,
  };
  return {
    ...item,
    ...(columns !== undefined ? { columns } : {}),
    ...(named !== undefined || indexes !== undefined
      ? { options: nextOptions(item.options, indexes) }
      : {}),
    archiveModel,
  } as AnyTable;
}

function childLinks(
  item: AnyTable,
  cascade: readonly string[],
  byName: ReadonlyMap<string, AnyTable>,
  accepted: readonly string[],
  edges: readonly Edge[],
  names: Names,
  schemaTraits: readonly object[] | undefined,
  archiveSql: string,
  idSql: string,
): ArchiveLink[] {
  const seen = new Set<string>();
  const links: ArchiveLink[] = [];
  for (const name of cascade) {
    if (seen.has(name))
      catalogError("OKM1020", `Cascade ${item.name} names ${name} more than once.`);
    seen.add(name);
    if (name === item.name) catalogError("OKM1020", `Cascade ${item.name} names itself.`);
    const child = byName.get(name);
    if (child === undefined) {
      throwNamed(
        "OKM1020",
        name,
        accepted,
        `Cascade ${item.name} names ${name}, which is not a table. Accepted names: ${list(accepted)}.`,
      );
    }
    if (!isArchivable(child, schemaTraits)) {
      catalogError("OKM1020", `Cascade ${item.name} names ${name}, which is not archivable.`);
    }
    const matches = edges.filter((edge) => edge.from === name && edge.to === item.name);
    if (matches.length !== 1) {
      const hint = matches.map((edge) => edge.field).sort();
      const which = hint.length === 0 ? "none" : hint.join(", ");
      catalogError(
        "OKM1021",
        `Cascade ${item.name} names ${name}, which has ${matches.length === 0 ? "no" : "more than one"} foreign key to ${item.name}. Accepted columns: ${which}.`,
      );
    }
    const edge = matches[0];
    if (edge === undefined) {
      catalogError(
        "OKM1021",
        `Cascade ${item.name} names ${name}, which has no foreign key to ${item.name}. Accepted columns: none.`,
      );
    }
    links.push({
      table: name,
      sql: names.table(child),
      at: archiveSql,
      id: idSql,
      local: edge.local,
      remote: edge.remote,
    });
  }
  return links;
}

function parentLinks(
  item: AnyTable,
  byName: ReadonlyMap<string, AnyTable>,
  edges: readonly Edge[],
  names: Names,
  schemaTraits: readonly object[] | undefined,
  archiveSql: string,
  idSql: string,
): ArchiveLink[] {
  const parents: ArchiveLink[] = [];
  for (const edge of edges) {
    if (edge.from !== item.name) continue;
    const parent = byName.get(edge.to);
    if (parent === undefined || !isArchivable(parent, schemaTraits)) continue;
    parents.push({
      table: parent.name,
      sql: names.table(parent),
      at: archiveSql,
      id: idSql,
      local: edge.local,
      remote: edge.remote,
    });
  }
  parents.sort((left, right) => compareText(left.table, right.table));
  return parents;
}

function foreignKeys(
  tables: readonly AnyTable[],
  names: Names,
  byName: ReadonlyMap<string, AnyTable>,
): Edge[] {
  const edges: Edge[] = [];
  for (const item of tables) {
    for (const [field, builder] of Object.entries(item.columns)) {
      if (!(builder instanceof ColumnBuilder)) continue;
      const reference = builder.state.references;
      if (reference === undefined) continue;
      const target = byName.get(reference.table);
      if (target === undefined) continue;
      edges.push({
        from: item.name,
        field,
        to: reference.table,
        local: localNames(item, field, reference, names),
        remote: remoteNames(target, reference, names),
      });
    }
  }
  return edges;
}

function localNames(
  item: AnyTable,
  field: string,
  reference: ReferenceModifier,
  names: Names,
): string[] {
  const local = [names.column(item, field)];
  for (const extra of reference.along ?? []) local.push(names.column(item, extra));
  return local;
}

function remoteNames(target: AnyTable, reference: ReferenceModifier, names: Names): string[] {
  if (reference.columns !== undefined) {
    return reference.columns.map((name) => names.column(target, name));
  }
  return primaryFields(target).map((name) => names.column(target, name));
}

function applies(
  self: object,
  item: AnyTable,
  schemaTraits: readonly object[] | undefined,
): boolean {
  const options = item.options as TableOptions | undefined;
  const own = Array.isArray(options?.traits) ? options.traits : [];
  if (own.includes(self)) return true;
  if (options?.omitDefaults !== undefined) return false;
  return schemaTraits?.includes(self) ?? false;
}

function isArchivable(item: AnyTable, schemaTraits: readonly object[] | undefined): boolean {
  const options = item.options as TableOptions | undefined;
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

function nextOptions(options: object | undefined, indexes: TableOptions["indexes"]): object {
  const record: Record<string, unknown> = { ...options };
  delete record.unique;
  if (indexes !== undefined) record.indexes = indexes;
  return record;
}

function partialIndex(columns: readonly string[], predicate: string): IndexCall {
  return buildIndex({ columns, isUnique: true, predicate });
}

function primaryFields(item: AnyTable): string[] {
  const listed = (item.options as TableOptions | undefined)?.primaryKey;
  if (listed !== undefined && listed.length > 0) return [...listed];
  const fields: string[] = [];
  for (const [field, builder] of Object.entries(item.columns)) {
    if (builder instanceof ColumnBuilder && builder.state.primaryKey === true) fields.push(field);
  }
  return fields;
}

/**
 * SQL names of the archive columns, and the predicate that hides archived rows.
 *
 * The predicate is the text Postgres prints back for it. Any other spelling
 * drifts.
 *
 * @param names - Name lookups for the schema
 * @returns The two column names and the predicate
 */
export function archiveNames(names: Names): {
  readonly at: string;
  readonly id: string;
  readonly predicate: string;
} {
  const at = names.name("archivedAt");
  return {
    at,
    id: names.name("archiveId"),
    predicate: `(${printedIdentifier(at)} IS NULL)`,
  };
}

function list(names: readonly string[]): string {
  return names.join(", ");
}
