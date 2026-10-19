/**
 * Traits (`okmodel/traits`).
 *
 * Importing this module is what puts a trait on a schema. An application that
 * does not import it does not load these columns.
 */

import { OkmError } from "../../contracts/error.js";
import { rewriteArchivable } from "../../dialects/pg/archive-bind.js";
import { uuid } from "../../dialects/pg/keys.js";
import { definition, unavailable } from "../../dialects/pg/misuse.js";
import { checkPresetNames, duplicatePreset, type PresetMap } from "../../dialects/pg/preset.js";
import { timestampRecords } from "../../dialects/pg/fn/touch.js";
import { timestamptz } from "../../dialects/pg/time.js";
import { integer } from "../../dialects/pg/integer.js";
import type { DriverPool } from "../../contracts/driver.js";
import type { QuerySchema, SchemaHookCtx } from "../../dialects/pg/model.js";
import type { AnyTable, RowFrom } from "../../dialects/pg/table.js";
import { installArchiveContributions } from "../archive-rules.js";
import { attachArchive } from "../archive-handle.js";
import { indexes, isRecord, type ArchiveView, type CallScope } from "../plan.js";
import type { Hookm, Timeouts } from "../types.js";
import { rewriteSortable } from "../sort-bind.js";
import {
  checkTrait,
  type Trait,
  type TraitContext,
  type TraitModel,
} from "../../dialects/pg/trait.js";

export type { Trait };

/**
 * Options `trait()` accepts.
 *
 * `methods` and `requires` are named here and rejected until the prompt that
 * implements them.
 *
 * @typeParam TFields - Columns the trait adds
 * @typeParam TPresets - Presets the trait adds to each table it applies to
 */
export type TraitDefinition<
  TFields extends Readonly<Record<string, object>>,
  TPresets extends PresetMap<RowFrom<TFields>> = PresetMap<RowFrom<TFields>>,
> = {
  readonly fields: TFields;
  /** Columns set to `now()` on update. Each one is sealed. */
  readonly touch?: readonly (keyof TFields & string)[];
  /** Columns input cannot set, including `{ allow }`. */
  readonly sealed?: readonly (keyof TFields & string)[];
  /**
   * Named query refinements added to every table the trait applies to.
   *
   * They see the trait's columns, not the table's. A name a table or another
   * trait also defines is OKM1040, and so is a reserved name.
   */
  readonly presets?: TPresets & PresetMap<RowFrom<TFields>>;
  readonly methods?: unknown;
  readonly requires?: unknown;
};

/**
 * Builds a trait.
 *
 * The same function the built-in traits use. `schema()` copies `fields` onto
 * each table and rejects a field the table already has (OKM1012).
 *
 * @typeParam TFields - Columns the trait adds
 * @param name - Provenance name stored on those columns
 * @param definition - Fields and, when needed, which ones the write path seals
 * @returns The trait
 */
export function trait<
  const TFields extends Readonly<Record<string, object>>,
  const TPresets extends PresetMap<RowFrom<TFields>> = Record<never, never>,
>(
  name: string,
  input: TraitDefinition<TFields, TPresets>,
): {
  readonly name: string;
  readonly fields: TFields;
  readonly touch?: readonly (keyof TFields & string)[];
  readonly sealed?: readonly (keyof TFields & string)[];
  apply(model: TraitModel, ctx: TraitContext): void;
  contribute(peers: unknown, built: unknown): readonly unknown[];
} & ([keyof TPresets] extends [never] ? unknown : { readonly presets: TPresets }) {
  if (input.presets !== undefined) checkPresetNames(Object.keys(input.presets), `trait ${name}`);
  if (input.methods !== undefined) {
    unavailable("Trait option methods is not available yet. It arrives in 0.2.");
  }
  if (input.requires !== undefined) {
    unavailable("Trait option requires is not available yet. It arrives in 0.2.");
  }
  const checked = checkTrait(
    {
      name,
      fields: input.fields,
      ...(input.touch !== undefined ? { touch: input.touch } : {}),
      ...(input.sealed !== undefined ? { sealed: input.sealed } : {}),
    },
    `trait(${name})`,
  );
  markFields(checked.fields, name);
  const sealed = sealTouch(checked.sealed, checked.touch);
  return {
    name,
    fields: checked.fields as TFields,
    ...(checked.touch !== undefined
      ? { touch: checked.touch as readonly (keyof TFields & string)[] }
      : {}),
    ...(sealed !== undefined ? { sealed: sealed as readonly (keyof TFields & string)[] } : {}),
    ...(input.presets !== undefined ? { presets: input.presets } : {}),
    apply(model, ctx) {
      addFields(name, checked.fields, model, ctx);
      if (input.presets !== undefined) addPresets(name, input.presets, model, ctx);
    },
    contribute() {
      return [];
    },
  } as ReturnType<typeof trait<TFields, TPresets>>;
}

function addPresets(
  name: string,
  presets: Readonly<Record<string, unknown>>,
  model: TraitModel,
  ctx: TraitContext,
): void {
  const merged: Record<string, unknown> = (model.presets = { ...model.presets });
  const from = (model.presetFrom ??= {});
  for (const key of Object.keys(presets)) {
    if (Object.hasOwn(merged, key)) {
      const first = from[key];
      duplicatePreset(
        key,
        ctx.table,
        first === undefined ? `table ${ctx.table}` : `trait ${first}`,
        `trait ${name}`,
      );
    }
    merged[key] = presets[key];
    from[key] = name;
  }
}

/**
 * Options for {@link timestamps}.
 *
 * `enforce: "trigger"` adds a before-update trigger and its function.
 */
export type TimestampsOptions = {
  readonly enforce?: "trigger";
};

/**
 * Adds `createdAt` and `updatedAt`.
 *
 * Both are `timestamptz not null default now()`, and input cannot set either
 * of them. Insert leaves them to the default, so one statement stamps both
 * with the same time. Update sets `updatedAt` to `now()` and leaves `createdAt`.
 * `{ enforce: "trigger" }` also writes `updatedAt` in the database, including
 * for writers that bypass the client.
 *
 * @param options - Pass `{ enforce: "trigger" }` for the database trigger
 * @returns The timestamps trait
 */
export function timestamps(options?: TimestampsOptions) {
  if (options !== undefined) {
    for (const key of Object.keys(options)) {
      if (key !== "enforce") {
        definition(`timestamps() option ${key} is not supported. Accepted options: enforce.`);
      }
    }
    if (options.enforce !== undefined && options.enforce !== "trigger") {
      definition(`timestamps() enforce ${String(options.enforce)} must be trigger.`);
    }
  }
  const base = trait("timestamps", {
    fields: {
      createdAt: stamped(),
      updatedAt: stamped(),
    },
    touch: ["updatedAt"],
    sealed: ["createdAt", "updatedAt"],
  });
  if (options?.enforce !== "trigger") return base;
  return {
    ...base,
    /**
     * Adds the touch function and one trigger per table.
     *
     * @param _peers - Unused. The columns are already in `built`
     * @param built - Objects staged before traits contribute
     * @returns The function and trigger records
     */
    contribute(_peers: unknown, built: unknown) {
      return timestampRecords(built);
    },
  };
}

function stamped() {
  return timestamptz().defaultSql("now()").guarded();
}

/**
 * Options for {@link archivable}.
 *
 * `strategy: "column"` keeps archived rows in the same table. `strategy: "table"`
 * is deferred. `cascade` names the child tables archived and restored with the row.
 */
export type ArchivableOptions = {
  /** `"table"` is reserved and throws OKM1061. */
  readonly strategy?: "column" | "table";
  readonly cascade?: readonly string[];
};

/**
 * Adds `archivedAt` and `archiveId`, and enables `archive()` and `restore()`.
 *
 * Reads, updates, and deletes target the active set. `withArchived()` and
 * `onlyArchived()` widen or switch it. Uniques on the table become partial.
 * `cascade` names children that share the call's `archiveId`.
 *
 * @param options - Column strategy and the child tables to cascade
 * @returns The archivable trait
 */
export function archivable(options?: ArchivableOptions) {
  installArchiveContributions();
  const cascade = readCascade(options);
  const base = trait("archivable", {
    fields: {
      archivedAt: timestamptz().nullable().guarded(),
      archiveId: uuid().nullable().guarded(),
    },
    sealed: ["archivedAt", "archiveId"],
  });
  const self = {
    ...base,
    "~archive": true as const,
    apply(model: TraitModel, ctx: TraitContext) {
      base.apply(model, ctx);
      model.archive = { at: "archivedAt", id: "archiveId", cascade };
    },
    /**
     * Turns uniques into partial indexes and checks cascade.
     *
     * Runs in the schema rewrite, after tenancy widens uniques.
     *
     * @param tables - Tables after the tenancy rewrite
     * @param casing - Schema casing
     * @param schemaTraits - Traits from `schema()`, when any were passed
     * @returns The rewritten tables
     */
    rewrite(
      tables: readonly AnyTable[],
      casing: "snake" | undefined,
      schemaTraits: readonly object[] | undefined,
    ) {
      return rewriteArchivable(self, tables, casing, schemaTraits, cascade);
    },
    hook: attachArchive,
  };
  return self;
}

/**
 * Adds `version` and checks it on every update.
 *
 * The column starts at 1. An update passes the version it read and the write
 * bumps it. A stale version is category `conflict` and changes nothing.
 * Input cannot set `version`.
 *
 * @returns The versioned trait
 */
export function versioned() {
  return {
    ...trait("versioned", {
      fields: {
        version: integer().defaultSql("1").guarded(),
      },
      sealed: ["version"],
    }),
    "~versioned": true as const,
  };
}

/**
 * Adds `position` and `move`.
 *
 * New rows go at the end of the group. `move` places a row before or after
 * another in that group. `find` and `page` order by `position` when the
 * caller does not pass `orderBy`. Input cannot set `position`.
 *
 * @param groupBy - Column that splits the order. Omit it for one list
 * @returns The sortable trait
 */
export function sortable(groupBy?: string) {
  if (groupBy !== undefined && groupBy.length === 0) {
    definition("sortable() groupBy must be a column name.");
  }
  if (groupBy === "position") definition("sortable() cannot group by position.");
  const base = trait("sortable", {
    fields: {
      position: integer().guarded(),
    },
    sealed: ["position"],
  });
  const self = {
    ...base,
    ...(groupBy !== undefined ? { group: groupBy } : {}),
    "~sort": true as const,
    apply(model: TraitModel, ctx: TraitContext) {
      if (groupBy !== undefined && !Object.hasOwn(model.columns, groupBy)) {
        definition(`sortable() on ${ctx.table} needs a column named ${groupBy}.`);
      }
      base.apply(model, ctx);
    },
    /**
     * Adds the unique position index after tenancy has widened uniques.
     *
     * @param tables - Tables after the tenancy rewrite
     * @param casing - Schema casing
     * @param schemaTraits - Traits from `schema()`, when any were passed
     * @returns The rewritten tables
     */
    rewrite(
      tables: readonly AnyTable[],
      casing: "snake" | undefined,
      schemaTraits: readonly object[] | undefined,
    ) {
      return rewriteSortable(self, tables, casing, schemaTraits, groupBy);
    },
    hook: attachSort,
  };
  return self;
}

type SortHost = {
  readonly schema: QuerySchema;
  readonly pool: DriverPool;
  readonly timeouts?: Timeouts | undefined;
  readonly hookm?: readonly Hookm[] | undefined;
  readonly tx?: object | undefined;
  readonly scope?: CallScope;
  readonly connected?: Promise<void>;
};

/**
 * Adds `move` and the default position order on a sortable table.
 *
 * @param target - The table handle being built
 * @param ctx - Table name and the session
 */
function attachSort(target: Record<string, unknown>, ctx: SchemaHookCtx): void {
  const tableName = ctx.table;
  const session = ctx.session;
  if (tableName === undefined || session === undefined) return;
  const host = session as SortHost;
  const table = indexes(host.schema).get(tableName);
  if (table === undefined) return;
  let sortableTable = false;
  for (const item of table.model.traits ?? []) {
    if (item.name === "sortable") sortableTable = true;
  }
  if (!sortableTable) return;
  const order: Record<string, "asc"> = { position: "asc" };
  for (const field of table.model.primary) {
    if (field !== "position") order[field] = "asc";
  }
  wrapOrder(target, "find", order);
  wrapOrder(target, "page", order);
  const view = ctx.view as ArchiveView | undefined;
  target.move = (id: unknown, place: unknown) =>
    import("../sort.js").then((mod) => mod.move(host, tableName, id, place, view));
}

function wrapOrder(
  target: Record<string, unknown>,
  key: string,
  order: Record<string, "asc">,
): void {
  const previous = target[key];
  if (typeof previous !== "function") return;
  target[key] = (options: object = {}) => {
    const next =
      isRecord(options) && options.orderBy !== undefined ? options : { ...options, orderBy: order };
    return (previous as (options: object) => unknown).call(target, next);
  };
}

declare module "../types.js" {
  interface TableExtras<S extends QuerySchema, K extends keyof S["~byName"] & string> {
    /**
     * Moves one row before or after another in the same group.
     *
     * The result is the row's position after the move. A missing id is
     * `not_found`. An anchor in another group is OKM1120.
     *
     * @param id - Primary key of the row to move, without the tenant key
     * @param place - `{ before }` or `{ after }`, the anchor's primary key
     * @returns The position after the move
     */
    move(
      id: unknown,
      place: { readonly before: unknown } | { readonly after: unknown },
    ): Promise<{ readonly position: number }>;
  }
}

function readCascade(options: ArchivableOptions | undefined): readonly string[] {
  if (options === undefined) return [];
  for (const key of Object.keys(options)) {
    if (key !== "strategy" && key !== "cascade") {
      definition(
        `archivable() option ${key} is not supported. Accepted options: strategy, cascade.`,
      );
    }
  }
  if (options.strategy === "table") {
    unavailable(
      'archivable({ strategy: "table" }) is not available yet. It arrives once archived snapshots can follow migrations.',
    );
  }
  if (options.strategy !== undefined && options.strategy !== "column") {
    definition(`archivable() strategy ${String(options.strategy)} must be column.`);
  }
  const cascade = options.cascade;
  if (cascade === undefined) return [];
  if (!Array.isArray(cascade)) definition("archivable() cascade must be a list of table names.");
  const names: string[] = [];
  for (const name of cascade) {
    if (typeof name !== "string" || name.length === 0) {
      definition("archivable() cascade must name tables.");
    }
    names.push(name);
  }
  return names;
}

/**
 * Remembers which trait added a column, so the catalog can record it.
 *
 * @param fields - Columns the trait adds
 * @param name - Trait name
 */
function markFields(fields: Readonly<Record<string, object>>, name: string): void {
  for (const field of Object.keys(fields)) {
    const builder = fields[field];
    if (typeof builder === "object" && builder !== null) Object.assign(builder, { trait: name });
  }
}

/**
 * A touched column is sealed. The write path reads this list lazily.
 *
 * @param sealed - Columns input cannot set
 * @param touch - Columns set to `now()` on update
 * @returns Both lists, or `undefined` when the trait seals nothing
 */
function sealTouch(
  sealed: readonly string[] | undefined,
  touch: readonly string[] | undefined,
): readonly string[] | undefined {
  if (touch === undefined) return sealed;
  if (sealed === undefined) return touch;
  const names = [...sealed];
  for (const field of touch) if (!names.includes(field)) names.push(field);
  return names;
}

/**
 * Copies one trait's columns onto a table.
 *
 * @param name - Trait name, for OKM1012
 * @param fields - Columns this trait adds
 * @param model - Columns collected so far, including the table's own
 * @param ctx - Table name
 */
function addFields(
  name: string,
  fields: Readonly<Record<string, object>>,
  model: TraitModel,
  ctx: TraitContext,
): void {
  for (const field of Object.keys(fields)) {
    const builder = fields[field];
    if (builder === undefined) continue;
    if (Object.hasOwn(model.columns, field)) {
      const previous = (model.columns[field] as { readonly trait?: unknown }).trait;
      const which =
        typeof previous === "string"
          ? `trait ${previous} already adds it`
          : `${ctx.table} already declares it`;
      throw new OkmError("OKM1012", `Trait ${name} adds ${ctx.table}.${field}, and ${which}.`, {
        fix: { summary: "Rename the table field or drop one of the traits." },
      });
    }
    model.columns[field] = builder;
  }
}
