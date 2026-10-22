/**
 * `table()`, index calls, and check text.
 *
 * `table()` stores the columns. It does not build catalog objects.
 * `schema()` does that.
 */

import { printedIdentifier } from "../../contracts/catalog/identifier.js";
import { throwNamed } from "../../contracts/error.js";
import { callerLocation, withLocation } from "../../contracts/location.js";
import { type ColumnInsertOf, type ColumnRowOf, type ColumnUpdateOf } from "./column.js";
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
 * `name` is the SQL name `schema()` will store.
 */
export type ColumnHandle = {
  readonly name: string;
};

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
   * Marks the index unique.
   *
   * On a tenant table the unique includes the tenant key, so two tenants may
   * share a value. `.global("reason")` keeps the unique global.
   *
   * @returns The same columns, unique
   */
  unique(): IndexCall;
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
};

/**
 * `index()` return, with the tenant scope methods always present.
 *
 * A hand-built {@link IndexCall} may omit them. Chaining stays on this type.
 */
export interface IndexChain extends IndexCall {
  /** @returns The same columns, unique */
  unique(): IndexChain;
  /**
   * Opts this index out of the tenant prefix.
   *
   * @param reason - Why this index is shared across tenants
   * @returns The same columns, unprefixed
   */
  global(reason: string): IndexChain;
  /**
   * Opts this index into the tenant prefix.
   *
   * @returns The same columns, prefixed when the table is a tenant table
   */
  scoped(): IndexChain;
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
export type SqlValue = string | number | boolean | null | ColumnHandle | SqlText;

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
    readonly [name: string]: (columns: Handles<TColumns>) => SqlText;
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
  readonly primaryKey?: readonly (keyof TColumns & string)[];
  readonly sqlName?: string;
  readonly renamedFrom?: string;
  readonly comment?: string;
  readonly validate?: unknown;
  readonly validation?: unknown;
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
  readonly policies?: unknown;
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
  "indexes",
  "omitDefaults",
  "presets",
  "primaryKey",
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
 * Later table options, and the version that adds each one.
 *
 * `later` names no version: the execution plan has no release for that option.
 */
const TABLE_LATER: Readonly<Record<string, string>> = {
  computed: "later",
  policies: "later",
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

/**
 * Declares an index from column handles.
 *
 * @param columns - Columns in index order
 * @returns An index call `schema()` compiles
 */
export function index(...columns: readonly ColumnHandle[]): IndexChain {
  return buildIndex({ columns: columns.map((column) => column.name) });
}

/**
 * Builds an index call, including `.unique()`, `.global()`, and `.scoped()`.
 *
 * Extension `using` tails and trait rewrites share this so the methods stay
 * one implementation. It is not on the `okmodel/pg` barrel.
 *
 * @param input - Columns, uniqueness, and an optional predicate or expression
 * @returns The index call `schema()` compiles
 */
export function buildIndex(input: {
  readonly columns: readonly string[];
  readonly isUnique?: boolean;
  readonly predicate?: string | undefined;
  readonly expression?: string | undefined;
  readonly tenantGlobal?: string | undefined;
  readonly tenantScoped?: boolean | undefined;
}): IndexChain {
  const columns = input.columns;
  const isUnique = input.isUnique === true;
  const predicate = input.predicate;
  const expression = input.expression;
  const tenantGlobal = input.tenantGlobal;
  const tenantScoped = input.tenantScoped === true ? true : undefined;
  return {
    columns,
    isUnique,
    ...(predicate !== undefined ? { predicate } : {}),
    ...(expression !== undefined ? { expression } : {}),
    ...(tenantGlobal !== undefined ? { tenantGlobal } : {}),
    ...(tenantScoped === true ? { tenantScoped: true } : {}),
    unique() {
      return buildIndex({
        columns,
        isUnique: true,
        predicate,
        expression,
        tenantGlobal,
        tenantScoped,
      });
    },
    global(reason: string) {
      if (typeof reason !== "string" || reason.trim().length === 0) {
        definition("index().global() needs a reason.");
      }
      return buildIndex({
        columns,
        isUnique,
        predicate,
        expression,
        tenantGlobal: reason.trim(),
      });
    },
    scoped() {
      return buildIndex({ columns, isUnique, predicate, expression, tenantScoped: true });
    },
  };
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
 * Converts a camelCase field name to snake_case.
 *
 * @param name - Field or table name
 * @returns The SQL spelling used when `casing` is `"snake"`
 */
export function snakeCase(name: string): string {
  let out = "";
  for (let index = 0; index < name.length; index += 1) {
    const char = name[index] ?? "";
    const lower = char.toLowerCase();
    if (lower !== char && char.toUpperCase() === char && out.length > 0 && !out.endsWith("_")) {
      out += "_";
    }
    out += lower;
  }
  return out;
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
 * Rejects options a later prompt owns, and unknown keys.
 *
 * @param options - Author object
 * @param known - Keys this prompt implements
 * @param later - Keys reserved for a named prompt
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
    const prompt = later[key];
    if (prompt !== undefined) {
      if (record[key] !== undefined) {
        const when = prompt === "later" ? "later" : `in ${prompt}`;
        unavailable(`${where} option ${key} is not available yet. It arrives ${when}.`);
      }
      continue;
    }
    if (!known.has(key)) {
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
