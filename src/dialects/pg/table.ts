/**
 * `table()`, index calls, and check text.
 *
 * `table()` stores the columns. It does not build catalog objects.
 * `schema()` does that.
 */

import { printedIdentifier } from "../../contracts/catalog/identifier.js";
import type { IndexElement, IndexStorage } from "../../contracts/catalog/types.js";
import { throwNamed } from "../../contracts/error.js";
import { printIndexText } from "./index-print.js";
import { callerLocation, withLocation } from "../../contracts/location.js";
import {
  type ColumnInsertOf,
  type ColumnRowOf,
  type ColumnUpdateOf,
  type ForeignKeySpec,
} from "./column.js";
import { openFilters } from "./filters.js";
import { definition, unavailable } from "./misuse.js";
import { type RelationCall } from "./relations.js";
import type { PresetMap } from "./preset.js";
import {
  type FieldsOfList,
  type HasArchive,
  type HasVersioned,
  type PresetsOfList,
  type Trait,
} from "./trait.js";

/**
 * A column as seen by `indexes` and `checks`.
 *
 * `name` is the SQL name `schema()` will store. `desc`, `nullsFirst`,
 * `nullsLast`, and `ops` mark one index key. They do not change the column.
 */
export type ColumnHandle = {
  readonly name: string;
  /** Stores `DESC` on this index key. */
  desc(): ColumnHandle;
  /** Stores `NULLS FIRST` on this index key. */
  nullsFirst(): ColumnHandle;
  /** Stores `NULLS LAST` on this index key. */
  nullsLast(): ColumnHandle;
  /**
   * Stores an operator class on this index key.
   *
   * @param name - Operator class, such as `text_pattern_ops`
   */
  ops(name: string): ColumnHandle;
  readonly order?: "desc";
  readonly nulls?: "first" | "last";
  readonly opclass?: string;
  /** SQL type. `range()` reads it. Indexes ignore it. */
  readonly dataType?: string;
};

/**
 * Builds the column handle `indexes` and `checks` receive.
 *
 * @param name - SQL column name
 * @param extra - Order, nulls, or operator class already chosen
 * @returns A handle
 */
export function columnHandle(
  name: string,
  extra?: {
    readonly order?: "desc";
    readonly nulls?: "first" | "last";
    readonly opclass?: string;
    readonly dataType?: string;
  },
): ColumnHandle {
  return {
    name,
    ...extra,
    desc: () => columnHandle(name, { ...extra, order: "desc" }),
    nullsFirst: () => columnHandle(name, { ...extra, nulls: "first" }),
    nullsLast: () => columnHandle(name, { ...extra, nulls: "last" }),
    ops: (opclass: string) => columnHandle(name, { ...extra, opclass }),
  };
}

/**
 * An index declared on a table.
 */
export type IndexCall = {
  readonly columns: readonly string[];
  readonly isUnique: boolean;
  /**
   * Partial-index predicate, stored as the catalog wrote it.
   *
   * Absent on an ordinary index.
   */
  readonly predicate?: string;
  /**
   * Raw index tail an extension may set on the call.
   *
   * A `using …` tail is the extension's index method. The core factory does
   * not read it. `compileIndexes` copies the field onto the catalog index.
   */
  readonly expression?: string;
  /** Access method. Absent means btree, and btree is not stored. */
  readonly method?: string;
  /** Covering columns, SQL names. The method is `include()`. */
  readonly included?: readonly string[];
  /** Keys that are not a plain ascending column list. */
  readonly elements?: readonly IndexElement[];
  /** Storage parameters, already spelled the way Postgres stores them. */
  readonly storage?: IndexStorage;
  /** PostgreSQL 15. Nulls compare equal. */
  readonly nullsNotDistinct?: boolean;
  /** Comment text. The method is `comment()`. Absent means unmanaged. */
  readonly commentText?: string;
  /**
   * Set by {@link IndexCall.global}. The catalog does not store it.
   *
   * A tenant schema leaves this index unprefixed.
   */
  readonly tenantGlobal?: string;
  /**
   * Set by {@link IndexCall.scoped}. The catalog does not store it.
   *
   * A tenant schema prefixes this index even when the table opted out.
   */
  readonly tenantScoped?: boolean;
  /**
   * SQL name stored on the index.
   *
   * Set by {@link IndexCall.name}. Absent means `{table}_{columns}_idx`.
   * A hand-built call may set this field. The catalog stores it as the
   * index name and still keeps the column `nameKey`.
   */
  readonly sqlName?: string;
  /**
   * Marks the index unique.
   *
   * On a tenant table the unique includes every tenant key, so two tenants may
   * share a value. `.global("reason")` keeps the unique global.
   *
   * @returns The same columns, unique
   */
  unique(options?: { readonly nullsNotDistinct?: boolean }): IndexCall;
  /**
   * Opts this index out of the tenant prefix.
   *
   * Present on {@link index}. A hand-built call may omit it. The reason is
   * required. An empty reason is OKM1060. The index does not gain the tenant
   * key, and OKM1706 does not apply. A later {@link IndexCall.scoped} wins.
   *
   * @param reason - Why this index is shared across tenants
   * @returns The same columns, unprefixed
   */
  global?(reason: string): IndexCall;
  /**
   * Opts this index into the tenant prefix.
   *
   * Present on {@link index}. It wins over `indexes: false` and
   * `tenantIndexes: false`. A later {@link IndexCall.global} wins. An index
   * that already leads with the tenant key is not prefixed twice.
   *
   * @returns The same columns, prefixed when the table is a tenant table
   */
  scoped?(): IndexCall;
  /**
   * Sets the SQL name stored for this index.
   *
   * Present on {@link index}. A hand-built call may set {@link IndexCall.sqlName}
   * instead. An empty name is OKM1060. The generated name stays
   * `{table}_{columns}_idx` when this is omitted. `okm pull` writes it when
   * the database name is not that generated name.
   *
   * @param sqlName - SQL identifier to store
   * @returns The same columns, under that name
   */
  name?(sqlName: string): IndexCall;
};

/**
 * `index()` return, with the tenant scope methods always present.
 *
 * A hand-built {@link IndexCall} may omit them. Chaining stays on this type.
 */
/** Storage `.with()` accepts for one access method. */
export type IndexStorageFor<M extends string> = M extends "btree"
  ? { readonly fillfactor?: number; readonly deduplicate_items?: boolean }
  : M extends "gin"
    ? { readonly fastupdate?: boolean; readonly gin_pending_list_limit?: number }
    : M extends "gist"
      ? { readonly fillfactor?: number; readonly buffering?: "auto" | "on" | "off" }
      : M extends "brin"
        ? { readonly pages_per_range?: number; readonly autosummarize?: boolean }
        : M extends "hash" | "spgist"
          ? { readonly fillfactor?: number }
          : Readonly<Record<string, string | number | boolean>>;

/** A where object, an expression, or `sql` text. */
export type IndexPredicate = unknown;

export interface IndexChain<M extends string = "btree"> extends IndexCall {
  /**
   * Marks the index unique.
   *
   * @param options - `nullsNotDistinct` is PostgreSQL 15
   * @returns The same index, unique
   */
  unique(options?: { readonly nullsNotDistinct?: boolean }): IndexChain<M>;
  /**
   * Opts this index out of the tenant prefix.
   *
   * @param reason - Why this index is shared across tenants
   * @returns The same columns, unprefixed
   */
  global(reason: string): IndexChain<M>;
  /**
   * Opts this index into the tenant prefix.
   *
   * @returns The same columns, prefixed when the table is a tenant table
   */
  scoped(): IndexChain<M>;
  /**
   * Sets the SQL name stored for this index.
   *
   * @param sqlName - SQL identifier to store
   * @returns The same columns, under that name
   */
  name(sqlName: string): IndexChain<M>;
  /**
   * Partial index predicate.
   *
   * A where object, an expression, or `sql` text. The catalog stores the SQL.
   *
   * @param predicate - Predicate
   * @returns The same index, partial
   */
  where(predicate: IndexPredicate): IndexChain<M>;
  /**
   * Access method. The planner still owns `CONCURRENTLY`.
   *
   * @param method - `btree`, `gin`, `gist`, `brin`, or an extension method
   * @returns The same index, using that method
   */
  using<const Next extends string>(method: Next): IndexChain<Next>;
  /**
   * Covering columns. Only plain columns are accepted later.
   *
   * @param columns - Column handles
   * @returns The same index, with `INCLUDE`
   */
  include(...columns: readonly ColumnHandle[]): IndexChain<M>;
  /**
   * Storage parameters. Builtin methods are typed. An extension method takes a record.
   *
   * @param storage - Parameters for this method
   * @returns The same index, with `WITH`
   */
  with(storage: IndexStorageFor<M>): IndexChain<M>;
  /**
   * Comment stored on the index.
   *
   * @param text - Comment text, verbatim
   * @returns The same index, with that comment
   */
  comment(text: string): IndexChain<M>;
}

/**
 * Text stored for a check constraint.
 *
 * The database normalises it later. Here it is the author's text.
 */
export type SqlText = {
  readonly text: string;
};

/** Values an {@link sql} template may interpolate. */
export type SqlValue =
  | string
  | number
  | boolean
  | null
  | ColumnHandle
  | { readonly name: string }
  | SqlText;

/**
 * Options `table()` stores.
 *
 * Keys that belong to a later prompt are accepted and rejected at runtime.
 *
 * @typeParam TColumns - Columns of this table
 */
export type TableOptions<TColumns> = {
  readonly indexes?: (columns: Handles<TColumns>) => readonly IndexCall[];
  readonly checks?: {
    readonly [name: string]:
      | ((columns: Handles<TColumns>) => SqlText)
      | {
          readonly expression: (columns: Handles<TColumns>) => SqlText;
          readonly enforced?: false;
          /** Comment on the check. Absent means unmanaged. */
          readonly comment?: string;
        };
  };
  readonly unique?: {
    readonly [name: string]: readonly (keyof TColumns & string)[];
  };
  /**
   * Composite primary key, in column order.
   *
   * A single-column key can use this or `.primaryKey()` on the column.
   * One table has one primary key.
   */
  readonly primaryKey?:
    | readonly (keyof TColumns & string)[]
    | {
        readonly columns: readonly (keyof TColumns & string)[];
        readonly withoutOverlaps: true;
      };
  readonly sqlName?: string;
  readonly renamedFrom?: string;
  readonly comment?: string;
  readonly validate?: unknown;
  readonly validation?: unknown;
  /**
   * Privileges for declared roles. Keys are `roles` keys.
   *
   * `"read"` is select. `"write"` is select, insert, update, and delete.
   * An object with this option replaces the baseline for managed roles.
   */
  readonly grants?: Readonly<Record<string, unknown>>;
  /**
   * Traits added to this table.
   *
   * Schema default traits are added as well, unless `omitDefaults` is set.
   */
  readonly traits?: readonly Trait[];
  /**
   * Skip schema default traits.
   *
   * The value is the reason. An empty reason is rejected when the schema is built.
   */
  readonly omitDefaults?: string;
  /**
   * Opts this table out of schema tenancy.
   *
   * `global("reason")` is the opt-out. `{ via }` arrives later.
   */
  readonly tenancy?:
    | { readonly kind: "global"; readonly reason: string }
    | { readonly via: string };
  readonly computed?: unknown;
  /**
   * Named, typed refinements called as `tasks.pending()`.
   *
   * A preset gets a builder and its own arguments and returns the builder.
   * The builder only adds predicates. A name that is a client method or is
   * reserved is OKM1040.
   */
  readonly presets?: PresetMap<RowFrom<TColumns>>;
  /**
   * Keyed row-level security policies.
   *
   * The function returns one policy per key. The key is the stored name.
   * Import `okmodel/policy` in this module so the compiler is installed
   * before the catalog is read.
   */
  readonly policies?: () => import("./policy-compile.js").PolicyMap;
  /**
   * Row security for this table.
   *
   * `true` enables it. `false` disables it. `{ force: true }` enables and
   * forces it. Absent with policies enables it. Absent without policies
   * leaves it off.
   */
  readonly rls?: import("./policy-compile.js").RlsOption;
  /**
   * Rows the application requires to exist.
   *
   * Apply inserts a row when its key is missing. It does not update or delete.
   * The rows stay on the schema. They are not a diff in the catalog.
   */
  readonly reference?: ReferenceOption;
  /** `one` and `many`. Other relation kinds stay reserved. */
  readonly relations?: unknown;
  /**
   * Turns the tenant prefix off or on for indexes on this table.
   *
   * `false` leaves each index as written, and one that does not lead with
   * the tenant key is OKM1706. `true` prefixes them. Omitted follows
   * `indexes` on the tenancy config, which defaults to true. An index
   * `.global("reason")` or `.scoped()` still wins.
   */
  readonly tenantIndexes?: boolean;
  /**
   * Named foreign keys. The key is the stored constraint name.
   *
   * Use this for a composite key. A single column can still use `.references()`.
   * Table and column names are strings, so the column type does not cycle.
   */
  readonly foreignKeys?: (columns: Handles<TColumns>) => Readonly<Record<string, ForeignKeySpec>>;
  /**
   * Exclusion constraints. The key is the name stem. The stored name is
   * `{table}_{key}_excl`.
   */
  readonly exclusions?: (
    columns: Handles<TColumns>,
  ) => Readonly<Record<string, import("./exclusion.js").ExclusionSpec>>;
};

/**
 * Column handles keyed by field name.
 *
 * @typeParam TColumns - Columns of this table
 */
export type Handles<TColumns> = {
  readonly [K in keyof TColumns]: ColumnHandle;
};

/**
 * A table value.
 *
 * `~row`, `~insert`, and `~update` are the shapes `Row`, `Insert`, and
 * `Update` read. They are computed here, once, from the column flags.
 *
 * @typeParam TName - Table name
 * @typeParam TColumns - Column builders
 * @typeParam TRelations - Relations declared on this table
 */
export type Table<
  TName extends string,
  TColumns,
  TRelations extends Readonly<Record<string, RelationCall>> = Readonly<Record<string, never>>,
  TKey extends string = never,
  TOptions = object,
> = {
  readonly "~name": TName;
  readonly "~columns": TColumns;
  readonly "~row": RowFrom<TColumns>;
  readonly "~insert": InsertFrom<TColumns>;
  readonly "~update": UpdateFrom<TColumns, TKey>;
  readonly "~relations": TRelations;
  readonly name: TName;
  readonly columns: TColumns;
  readonly options?: TOptions;
  /**
   * Allowlisted client filters.
   *
   * A hidden field in `allow`, `sort`, or `relations` throws OKM1123 here.
   * `parse` loads the parser on first use. An operator outside
   * {@link FilterOperator} is not assignable.
   *
   * @param spec - Fields, operators, and sorts the caller may send
   * @returns A parser for one request object
   */
  filters(spec: FilterSpec): { parse(query: unknown): Promise<ParsedFilters> };
};

/**
 * Operators `filters().parse` applies.
 *
 * `path`, `matches`, `similar`, `wordSimilar`, boolean trees, relation
 * quantifiers, and write operators are not in this list. A caller cannot
 * name them in `allow`.
 */
export type FilterOperator =
  | "eq"
  | "in"
  | "inList"
  | "notIn"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "between"
  | "startsWith"
  | "endsWith"
  | "contains"
  | "like"
  | "ilike"
  | "not"
  | "containedBy"
  | "overlaps"
  | "hasKey"
  | "hasAnyKey";

/** What {@link Table.filters} accepts. */
export type FilterSpec = {
  readonly allow?: Readonly<Record<string, readonly FilterOperator[]>>;
  readonly sort?: readonly string[];
  /**
   * Relation name to the fields a caller may filter.
   *
   * `parse` turns `{ list: { name: { startsWith: "a" } } }` into `has`.
   */
  readonly relations?: Readonly<Record<string, readonly string[]>>;
};

/** `where` and `orderBy` a caller can spread into `find`. */
export type ParsedFilters = {
  readonly where: Readonly<Record<string, unknown>>;
  readonly orderBy?: Readonly<Record<string, "asc" | "desc">>;
};

/**
 * Any table `schema()` can compile.
 */
export type AnyTable = {
  readonly "~name": string;
  readonly "~row": unknown;
  readonly "~insert": unknown;
  readonly "~update": unknown;
  readonly "~relations"?: Readonly<Record<string, RelationCall>>;
  readonly name: string;
  readonly columns: Readonly<Record<string, object>>;
  readonly options?: object;
  /** `file.ts:line` of the `table()` call. Not part of the catalog hash. */
  readonly source?: string;
};

/**
 * Row shape. Hidden columns are omitted.
 *
 * @typeParam TColumns - Column builders
 */
export type RowFrom<TColumns> = {
  readonly [K in keyof TColumns as ColumnRowOf<TColumns[K]> extends never ? never : K]: ColumnRowOf<
    TColumns[K]
  >;
};

/**
 * Insert shape. Omitted columns are dropped. Optional ones include `undefined`.
 *
 * @typeParam TColumns - Column builders
 */
export type InsertFrom<TColumns> = {
  readonly [
    K in keyof TColumns as ColumnInsertOf<TColumns[K]> extends never ? never : K
  ]: ColumnInsertOf<TColumns[K]>;
};

/**
 * Update shape. Omitted columns are dropped. The rest include `undefined`.
 *
 * @typeParam TColumns - Column builders
 */
export type UpdateFrom<TColumns, TKey extends string = never> = {
  readonly [
    K in keyof TColumns as K extends TKey
      ? never
      : ColumnUpdateOf<TColumns[K]> extends never
        ? never
        : K
  ]: ColumnUpdateOf<TColumns[K]>;
};

const TABLE_KNOWN = new Set([
  "checks",
  "comment",
  "foreignKeys",
  "grants",
  "indexes",
  "omitDefaults",
  "policies",
  "presets",
  "rls",
  "primaryKey",
  "exclusions",
  "reference",
  "relations",
  "renamedFrom",
  "sqlName",
  "tenancy",
  "tenantIndexes",
  "traits",
  "unique",
  "validate",
  "validation",
]);

/**
 * Table options this version refuses, and what the error says about each.
 *
 * Each value is the sentence that follows `is not available yet.`
 */
const TABLE_LATER: Readonly<Record<string, string>> = {
  computed: "Declare it in schema({ computed }).",
};

/**
 * Rows declared with the table option `reference`.
 *
 * `key` is one column name or several, in constraint order. `rows` are the
 * values apply inserts when that key is absent.
 */
export type ReferenceOption = {
  readonly key: string | readonly string[];
  readonly rows: readonly Readonly<Record<string, string | number | boolean | null>>[];
};

/**
 * Declares a table.
 *
 * The catalog objects are built in `schema()`, not here.
 *
 * @typeParam TName - Table name
 * @typeParam TColumns - Column builders
 * @param name - Table name used by references and row types
 * @param columns - Columns keyed by field name
 * @param options - Indexes, checks, unique constraints, and names
 * @returns The table
 */
export function table<
  const TName extends string,
  const TColumns extends Readonly<Record<string, object>>,
>(name: TName, columns: TColumns): Table<TName, TColumns, Readonly<Record<string, never>>, never>;
export function table<
  const TName extends string,
  const TColumns extends Readonly<Record<string, object>>,
  const TOptions extends TableOptions<TColumns>,
>(name: TName, columns: TColumns, options: TOptions): DeclaredTable<TName, TColumns, TOptions>;
export function table<
  const TName extends string,
  const TColumns extends Readonly<Record<string, object>>,
>(
  name: TName,
  columns: TColumns,
  options?: TableOptions<TColumns>,
): Table<TName, TColumns, Readonly<Record<string, RelationCall>>, string> {
  const source = callerLocation(1);
  if (name.length === 0) {
    definition(withLocation("table() needs a name.", source));
  }
  if (options !== undefined) rejectLater(options, TABLE_KNOWN, TABLE_LATER, `Table ${name}`);
  remember(name, columns);
  return {
    name,
    columns,
    filters(spec: FilterSpec) {
      const ownHidden = hiddenColumnFields(columns);
      return openFilters(name, options?.relations, spec, (tableName, field) =>
        tableName === name ? ownHidden.has(field) : hiddenFields.has(`${tableName}.${field}`),
      );
    },
    ...(options !== undefined ? { options } : {}),
    ...(source !== undefined ? { source } : {}),
  } as unknown as Table<TName, TColumns, Readonly<Record<string, RelationCall>>, string>;
}

/**
 * Relation map stored on a table.
 *
 * Absent relations are an empty map, so a table without `relations` does not
 * grow a conditional at every call.
 *
 * @typeParam TOptions - Options argument, or `undefined`
 */
type RelationsOf<TOptions> = TOptions extends { readonly relations: infer R }
  ? R extends Readonly<Record<string, RelationCall>>
    ? R
    : Readonly<Record<string, never>>
  : Readonly<Record<string, never>>;

/**
 * Column names listed in a table's `primaryKey` option.
 *
 * Absent when the option is omitted, so a table without it does not change
 * its update shape.
 *
 * @typeParam TOptions - Options argument
 */
type PrimaryOf<TOptions> = TOptions extends { readonly primaryKey: infer K }
  ? K extends readonly (infer F)[]
    ? Extract<F, string>
    : never
  : never;

/**
 * Table type callers see, including trait fields and an opt-out of schema traits.
 *
 * @typeParam TName - Table name
 * @typeParam TColumns - Column builders
 * @typeParam TOptions - Options argument
 */
type DeclaredTable<TName extends string, TColumns, TOptions> = Table<
  TName,
  TColumns,
  RelationsOf<TOptions>,
  PrimaryOf<TOptions>,
  NoInfer<TOptions>
> &
  TraitShapes<TColumns, TOptions> &
  ArchiveFlag<TOptions> &
  PresetFlag<TOptions> &
  OmitFlag<TOptions> &
  GlobalFlag<TOptions> &
  PathFlag<TOptions>;

type ArchiveFlag<TOptions> = TOptions extends { readonly traits: infer TTraits }
  ? HasArchive<TTraits>
  : unknown;

/** `{ "~presets" }` from the table's own `presets` and its traits' presets, when there are any. */
type PresetFlag<TOptions> = (TOptions extends { readonly presets: infer TPresets }
  ? { readonly "~presets": TPresets }
  : unknown) &
  (TOptions extends { readonly traits: infer TTraits } ? PresetsOfList<TTraits> : unknown);

type OmitFlag<TOptions> = TOptions extends { readonly omitDefaults: string }
  ? { readonly "~omitDefaults": true }
  : unknown;

type GlobalFlag<TOptions> = TOptions extends {
  readonly tenancy: { readonly kind: "global"; readonly reason: infer TReason };
}
  ? { readonly "~global": TReason }
  : unknown;

/** A path table keeps its own columns. The schema type does not add the tenant key. */
type PathFlag<TOptions> = TOptions extends {
  readonly tenancy: { readonly via: infer TVia extends string };
}
  ? { readonly "~path": TVia }
  : unknown;

type TraitShapes<TColumns, TOptions> = TOptions extends { readonly traits: infer TTraits }
  ? (TTraits extends readonly { readonly fields: Readonly<Record<string, object>> }[]
      ? keyof FieldsOfList<TTraits> extends never
        ? unknown
        : {
            readonly "~row": RowFrom<TColumns> & RowFrom<FieldsOfList<TTraits>>;
            readonly "~insert": InsertFrom<TColumns> & InsertFrom<FieldsOfList<TTraits>>;
            readonly "~update": UpdateFrom<TColumns, PrimaryOf<TOptions>> &
              UpdateFrom<FieldsOfList<TTraits>>;
          }
      : unknown) &
      HasVersioned<TTraits>
  : unknown;

let fieldSql: (field: string) => string = (field) => field;

/**
 * Maps where-object keys to SQL names while `indexes` runs.
 *
 * @param resolve - Field name to SQL name
 */
export function bindIndexNames(resolve: (field: string) => string): void {
  fieldSql = resolve;
}

/** Restores field keys as SQL names. */
export function clearIndexNames(): void {
  fieldSql = (field) => field;
}

/**
 * Declares an index from column handles, one expression, or `sql` text.
 *
 * @param first - A column, an expression, or `sql` text
 * @param rest - Further columns, then one expression. An expression takes no columns after it
 * @returns An index call `schema()` compiles
 */
export function index(...args: readonly unknown[]): IndexChain {
  const first = args[0];
  if (first === undefined) definition("index() needs a column or an expression.");
  if (isColumnHandle(first)) {
    const handles: IndexKey[] = [];
    let expression: string | undefined;
    for (const arg of args) {
      if (isColumnHandle(arg)) {
        if (expression !== undefined) definition("index() takes columns, then one expression.");
        handles.push(arg);
        continue;
      }
      if (expression !== undefined) definition("index() takes one expression.");
      expression = printIndexText(arg, fieldSql);
    }
    const marked = handles.some(
      (handle) =>
        handle.order !== undefined || handle.nulls !== undefined || handle.opclass !== undefined,
    );
    return buildIndex({
      columns: handles.map((handle) => handle.name),
      ...(expression !== undefined ? { expression } : {}),
      ...(marked ? { elements: handles.map(elementFrom) } : {}),
    });
  }
  if (args.length > 1) definition("index() takes columns or one expression.");
  return buildIndex({ columns: [], expression: printIndexText(first, fieldSql) });
}

/** Fields {@link buildIndex} stores. Methods are added by the chain. */
export type IndexBuild = {
  readonly columns: readonly string[];
  readonly isUnique?: boolean;
  readonly predicate?: string;
  readonly expression?: string;
  readonly method?: string;
  readonly include?: readonly string[];
  readonly elements?: readonly IndexElement[];
  readonly storage?: IndexStorage;
  readonly nullsNotDistinct?: boolean;
  readonly comment?: string;
  readonly tenantGlobal?: string;
  readonly tenantScoped?: boolean;
  readonly sqlName?: string;
};

/**
 * Builds an index call, including the chain methods.
 *
 * Extension `using` tails and trait rewrites share this so the methods stay
 * one implementation. It is not on the `okmodel/pg` barrel.
 *
 * @param input - Columns, uniqueness, and optional index options
 * @returns The index call `schema()` compiles
 */
export function buildIndex(input: IndexBuild): IndexChain {
  return chain(indexData(input));
}

type IndexData = {
  readonly columns: readonly string[];
  readonly isUnique: boolean;
  readonly predicate?: string;
  readonly expression?: string;
  readonly method?: string;
  readonly included?: readonly string[];
  readonly elements?: readonly IndexElement[];
  readonly storage?: IndexStorage;
  readonly nullsNotDistinct?: boolean;
  readonly commentText?: string;
  readonly tenantGlobal?: string;
  readonly tenantScoped?: boolean;
  readonly sqlName?: string;
};

function indexData(input: IndexBuild): IndexData {
  return {
    columns: input.columns,
    isUnique: input.isUnique === true,
    ...(input.predicate !== undefined ? { predicate: input.predicate } : {}),
    ...(input.expression !== undefined ? { expression: input.expression } : {}),
    ...(input.method !== undefined && input.method !== "btree" ? { method: input.method } : {}),
    ...(input.include !== undefined ? { included: input.include } : {}),
    ...(input.elements !== undefined ? { elements: input.elements } : {}),
    ...(input.storage !== undefined ? { storage: input.storage } : {}),
    ...(input.nullsNotDistinct === true ? { nullsNotDistinct: true } : {}),
    ...(input.comment !== undefined ? { commentText: input.comment } : {}),
    ...(input.tenantGlobal !== undefined ? { tenantGlobal: input.tenantGlobal } : {}),
    ...(input.tenantScoped === true ? { tenantScoped: true } : {}),
    ...(input.sqlName !== undefined ? { sqlName: input.sqlName } : {}),
  };
}

function chain(state: IndexData): IndexChain {
  const call: IndexChain = {
    columns: state.columns,
    isUnique: state.isUnique === true,
    ...(state.predicate !== undefined ? { predicate: state.predicate } : {}),
    ...(state.expression !== undefined ? { expression: state.expression } : {}),
    ...(state.method !== undefined ? { method: state.method } : {}),
    ...(state.included !== undefined ? { included: state.included } : {}),
    ...(state.elements !== undefined ? { elements: state.elements } : {}),
    ...(state.storage !== undefined ? { storage: state.storage } : {}),
    ...(state.nullsNotDistinct === true ? { nullsNotDistinct: true } : {}),
    ...(state.commentText !== undefined ? { commentText: state.commentText } : {}),
    ...(state.tenantGlobal !== undefined ? { tenantGlobal: state.tenantGlobal } : {}),
    ...(state.tenantScoped === true ? { tenantScoped: true } : {}),
    ...(state.sqlName !== undefined ? { sqlName: state.sqlName } : {}),
    unique(options?: { readonly nullsNotDistinct?: boolean }) {
      return chain({
        ...state,
        isUnique: true,
        ...(options?.nullsNotDistinct === true ? { nullsNotDistinct: true } : {}),
      });
    },
    global(reason: string) {
      if (typeof reason !== "string" || reason.trim().length === 0) {
        definition("index().global() needs a reason.");
      }
      const { tenantScoped: _scoped, ...rest } = state;
      return chain({ ...rest, tenantGlobal: reason.trim() });
    },
    scoped() {
      const { tenantGlobal: _global, ...rest } = state;
      return chain({ ...rest, tenantScoped: true });
    },
    name(next: string) {
      if (next.length === 0) definition("index().name() must be a non-empty SQL identifier.");
      return chain({ ...state, sqlName: next });
    },
    where(predicate: IndexPredicate) {
      return chain({ ...state, predicate: printIndexText(predicate, fieldSql) });
    },
    using<const Next extends string>(method: Next) {
      if (method.length === 0) definition("index().using() needs a method.");
      const { method: _method, ...rest } = state;
      return chain(method === "btree" ? rest : { ...rest, method }) as IndexChain<Next>;
    },
    include(...columns: readonly ColumnHandle[]) {
      return chain({ ...state, included: columns.map((column) => column.name) });
    },
    with(storage: IndexStorageFor<string>) {
      return chain({ ...state, storage: storageRecord(storage) });
    },
    comment(text: string) {
      return chain({ ...state, commentText: text });
    },
  };
  return call;
}

type IndexKey = {
  readonly name: string;
  readonly order?: "desc";
  readonly nulls?: "first" | "last";
  readonly opclass?: string;
};

function isColumnHandle(value: unknown): value is IndexKey {
  return (
    value !== null &&
    typeof value === "object" &&
    "name" in value &&
    typeof value.name === "string" &&
    !("text" in value)
  );
}

function elementFrom(handle: IndexKey): IndexElement {
  return {
    column: handle.name,
    ...(handle.order !== undefined ? { order: handle.order } : {}),
    ...(handle.nulls !== undefined ? { nulls: handle.nulls } : {}),
    ...(handle.opclass !== undefined ? { opclass: handle.opclass } : {}),
  };
}

function storageRecord(storage: IndexStorageFor<string>): IndexStorage {
  const out: Record<string, string> = {};
  for (const key of Object.keys(storage).sort()) {
    const value = storage[key];
    if (typeof value === "boolean") out[key] = value ? "on" : "off";
    else if (value !== undefined) out[key] = String(value);
  }
  return out;
}

/**
 * Captures a check expression as text.
 *
 * Column handles become their SQL names, double-quoted when Postgres would fold
 * or reject them bare. This is not a query builder.
 *
 * @param strings - Literal parts
 * @param values - Interpolated columns, text, or numbers
 * @returns The expression `schema()` stores
 */
export function sql(strings: TemplateStringsArray, ...values: readonly SqlValue[]): SqlText {
  let text = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    text += sqlValue(values[index]);
    text += strings[index + 1] ?? "";
  }
  return { text };
}

/**
 * Type name emitted for a table: `tasks` becomes `Tasks`.
 *
 * @param name - Table name
 * @returns A TypeScript identifier
 */
export function emittedTypeName(name: string): string {
  let out = "";
  let capitalize = true;
  for (const char of name) {
    const letter = (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
    const digit = char >= "0" && char <= "9";
    if (!letter && !digit) {
      capitalize = true;
      continue;
    }
    if (capitalize && letter) {
      out += char.toUpperCase();
      capitalize = false;
      continue;
    }
    out += char;
    capitalize = false;
  }
  // Empty name. `length === 0` is the same check and spends the app startup gate.
  if (!out) return "Table";
  const first = out[0] ?? "";
  if (first >= "0" && first <= "9") {
    return `T${out}`;
  }
  return out;
}

/**
 * Rejects options this version refuses, and unknown keys.
 *
 * @param options - Author object
 * @param known - Keys this version implements
 * @param later - Keys it refuses, each with the rest of the sentence that names it
 * @param where - Table or schema name used in the message
 */
export function rejectLater(
  options: object,
  known: ReadonlySet<string>,
  later: Readonly<Record<string, string>>,
  where: string,
): void {
  const record = options as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const hint = later[key];
    if (hint !== undefined) {
      if (record[key] !== undefined) {
        unavailable(`${where} option ${key} is not available yet. ${hint}`);
      }
    } else if (!known.has(key)) {
      const accepted = [...known].sort().join(", ");
      const candidates = [...known, ...Object.keys(later)];
      throwNamed(
        "OKM1060",
        key,
        candidates,
        `${where} option ${key} is not supported. Accepted options: ${accepted}.`,
      );
    }
  }
}

function sqlValue(value: SqlValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "null";
  }
  if ("text" in value && typeof value.text === "string") {
    return value.text;
  }
  if ("name" in value && typeof value.name === "string") {
    return printedIdentifier(value.name);
  }
  definition("sql accepts a column, a string, a number, a boolean, or null.");
}

/**
 * Hidden `table.field` keys for relation allowlists on `filters()`.
 *
 * Own-table allow/sort use the calling instance's columns. Related names use
 * this set: each `table(name, …)` replaces that name's entries so a later
 * definition without `.hidden()` does not keep a prior mark (test suites and
 * hot reload redefine the same SQL name).
 */
const hiddenFields = new Set<string>();

function hiddenColumnFields(columns: Readonly<Record<string, object>>): ReadonlySet<string> {
  const fields = new Set<string>();
  for (const field of Object.keys(columns)) {
    const column = columns[field] as { readonly state?: { readonly hidden?: boolean } } | undefined;
    if (column?.state?.hidden === true) fields.add(field);
  }
  return fields;
}

function remember(name: string, columns: Readonly<Record<string, object>>): void {
  const prefix = `${name}.`;
  for (const key of hiddenFields) {
    if (key.startsWith(prefix)) hiddenFields.delete(key);
  }
  for (const field of hiddenColumnFields(columns)) {
    hiddenFields.add(`${name}.${field}`);
  }
}
