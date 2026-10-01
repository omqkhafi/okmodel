/**
 * Catalogs and drafts the safety tests and the runtime bench share.
 */

import {
  type Catalog,
  type PresetDef,
  type QueryDraft,
  type TableMeta,
  type TraitName,
  defineTable,
} from "./model.js";

/**
 * Tasks, lists, and countries.
 *
 * Tasks carry tenancy, both traits, a hidden field, a sensitive field, and a
 * guarded field. Lists are the relation target. Countries are global.
 *
 * @returns A three-table catalog
 */
export function sampleCatalog(): Catalog {
  return catalogFor();
}

/**
 * Sample catalog with a configurable tasks table.
 *
 * @param options - Tenancy, traits, and exposure on `tasks`
 * @returns Tasks, lists, and countries
 */
export function catalogFor(options?: {
  readonly tenancy?: "column" | "global";
  readonly traits?: readonly TraitName[];
  readonly hidden?: boolean;
  readonly sensitive?: boolean;
}): Catalog {
  return { tables: [tasksTable(options), listsTable(), countriesTable()] };
}

/**
 * A find that should verify: a limit, a caller filter, and the pending preset.
 *
 * @returns A draft against {@link sampleCatalog}
 */
export function validFind(): QueryDraft {
  return {
    op: "find",
    table: "tasks",
    presets: ["pending"],
    limit: 50,
    caller: [{ column: "title", op: "eq", parameter: "$title" }],
  };
}

/**
 * Builds `count` tenant tables and a find that touches all of them.
 *
 * @param tables - How many tables the query touches
 * @param predicates - Caller filters on the first table
 * @returns Catalog and draft
 */
export function sizedQuery(
  tables: number,
  predicates: number,
): { readonly catalog: Catalog; readonly draft: QueryDraft } {
  const built: TableMeta[] = [];
  for (let index = 0; index < tables; index += 1) {
    built.push(sizedTable(index));
  }
  const caller = Array.from({ length: predicates }, () => ({
    column: "title",
    op: "eq" as const,
    parameter: "$title",
  }));
  return {
    catalog: { tables: built },
    draft: {
      op: "find",
      table: "t0",
      touched: built.slice(1).map((table) => table.name),
      caller,
      limit: 20,
    },
  };
}

/**
 * Tasks table used by the sample catalog.
 *
 * @param options - Trait and exposure overrides
 * @returns The table
 */
export function tasksTable(options?: {
  readonly tenancy?: "column" | "global";
  readonly traits?: readonly TraitName[];
  readonly hidden?: boolean;
  readonly sensitive?: boolean;
}): TableMeta {
  const tenancy = options?.tenancy ?? "column";
  const traits = options?.traits ?? ["timestamps", "archivable"];
  return defineTable({
    name: "tasks",
    tenancy,
    ...(tenancy === "global" ? { globalReason: "report" } : {}),
    traits,
    relations: { list: "lists" },
    presets: [...PRESETS],
    fields: [
      { name: "id" },
      { name: "tenantId", tenantKey: tenancy === "column" },
      { name: "title" },
      { name: "status" },
      { name: "notes" },
      { name: "dueAt" },
      { name: "completedAt" },
      { name: "secret", hidden: options?.hidden ?? true },
      { name: "token", sensitive: options?.sensitive ?? true },
      { name: "role", guarded: true },
      { name: "createdAt" },
      { name: "updatedAt" },
      { name: "archivedAt", archive: traits.includes("archivable") },
      { name: "archiveId" },
    ],
  });
}

function listsTable(): TableMeta {
  return defineTable({
    name: "lists",
    tenancy: "column",
    traits: ["archivable"],
    fields: [
      { name: "id" },
      { name: "tenantId", tenantKey: true },
      { name: "name" },
      { name: "secret", hidden: true },
      { name: "archivedAt", archive: true },
      { name: "archiveId" },
    ],
  });
}

function countriesTable(): TableMeta {
  return defineTable({
    name: "countries",
    tenancy: "global",
    globalReason: "reference data",
    fields: [{ name: "id" }, { name: "name" }],
  });
}

function sizedTable(index: number): TableMeta {
  return defineTable({
    name: `t${String(index)}`,
    tenancy: "column",
    traits: ["archivable"],
    fields: [
      { name: "id" },
      { name: "tenantId", tenantKey: true },
      { name: "title" },
      { name: "archivedAt", archive: true },
      { name: "archiveId" },
    ],
  });
}

/** Preset names on the sample tasks table. */
export const PRESET_NAMES = ["pending", "ownedBy", "dueSoon"] as const;

/** A sample preset name. */
export type PresetName = (typeof PRESET_NAMES)[number];

const PRESETS: readonly PresetDef[] = [
  {
    name: "pending",
    location: "schema.ts:12",
    predicates: [{ column: "completedAt", op: "isNull", parameter: undefined }],
  },
  {
    name: "ownedBy",
    location: "schema.ts:13",
    predicates: [{ column: "role", op: "eq", parameter: "$owner" }],
  },
  {
    name: "dueSoon",
    location: "schema.ts:14",
    predicates: [{ column: "dueAt", op: "lt", parameter: "$soon" }],
  },
];
