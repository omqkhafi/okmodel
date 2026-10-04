/**
 * `table()`, index calls, and check text.
 *
 * `table()` stores the columns. It does not build catalog objects.
 * `schema()` does that.
 */

import { throwNamed } from "../../contracts/error.js";
import { callerLocation, withLocation } from "../../contracts/location.js";
import { type ColumnInsertOf, type ColumnRowOf, type ColumnUpdateOf } from "./column.js";
import { openFilters } from "./filters.js";
import { definition, unavailable } from "./misuse.js";
import { type RelationCall } from "./relations.js";
import { type FieldsOfList, type HasArchive, type Trait } from "./trait.js";

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
   * Marks the index unique.
   *
   * @returns The same columns, unique
   */
  unique(): IndexCall;
};

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
  readonly presets?: unknown;
  readonly policies?: unknown;
  readonly reference?: unknown;
  /** `one` and `many`. Other relation kinds stay reserved. */
  readonly relations?: unknown;
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
> = {
  readonly "~name": TName;
  readonly "~columns": TColumns;
  readonly "~row": RowFrom<TColumns>;
  readonly "~insert": InsertFrom<TColumns>;
  readonly "~update": UpdateFrom<TColumns, TKey>;
  readonly "~relations": TRelations;
  readonly name: TName;
  readonly columns: TColumns;
  readonly options?: TableOptions<TColumns>;
  /**
   * Allowlisted client filters.
   *
   * A hidden field in `allow`, `sort`, or `relations` throws OKM1123 here.
   * `parse` loads the parser on first use.
   *
   * @param spec - Fields, operators, and sorts the caller may send
   * @returns A parser for one request object
   */
  filters(spec: FilterSpec): { parse(query: unknown): Promise<ParsedFilters> };
};

/** What {@link Table.filters} accepts. */
export type FilterSpec = {
  readonly allow?: Readonly<Record<string, readonly string[]>>;
  readonly sort?: readonly string[];
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
  "primaryKey",
  "relations",
  "renamedFrom",
  "sqlName",
  "tenancy",
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
  presets: "0.2",
  reference: "0.4",
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
  if (options !== undefined) {
    rejectLater(options, TABLE_KNOWN, TABLE_LATER, `Table ${name}`);
  }
  remember(name, columns);
  return {
    name,
    columns,
    filters(spec: FilterSpec) {
      return openFilters(name, options?.relations, spec, hiddenFields);
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
  PrimaryOf<TOptions>
> &
  TraitShapes<TColumns, TOptions> &
  ArchiveFlag<TOptions> &
  OmitFlag<TOptions> &
  GlobalFlag<TOptions>;

type ArchiveFlag<TOptions> = TOptions extends { readonly traits: infer TTraits }
  ? HasArchive<TTraits>
  : unknown;

type OmitFlag<TOptions> = TOptions extends { readonly omitDefaults: string }
  ? { readonly "~omitDefaults": true }
  : unknown;

type GlobalFlag<TOptions> = TOptions extends {
  readonly tenancy: { readonly kind: "global"; readonly reason: infer TReason };
}
  ? { readonly "~global": TReason }
  : unknown;

type TraitShapes<TColumns, TOptions> = TOptions extends { readonly traits: infer TTraits }
  ? TTraits extends readonly { readonly fields: Readonly<Record<string, object>> }[]
    ? keyof FieldsOfList<TTraits> extends never
      ? unknown
      : {
          readonly "~row": RowFrom<TColumns> & RowFrom<FieldsOfList<TTraits>>;
          readonly "~insert": InsertFrom<TColumns> & InsertFrom<FieldsOfList<TTraits>>;
          readonly "~update": UpdateFrom<TColumns, PrimaryOf<TOptions>> &
            UpdateFrom<FieldsOfList<TTraits>>;
        }
    : unknown
  : unknown;

/**
 * Declares an index from column handles.
 *
 * @param columns - Columns in index order
 * @returns An index call `schema()` compiles
 */
export function index(...columns: readonly ColumnHandle[]): IndexCall {
  return indexCall(
    columns.map((column) => column.name),
    false,
  );
}

/**
 * Captures a check expression as text.
 *
 * Column handles become their SQL names. This is not a query builder.
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
  if (out.length === 0) {
    return "Table";
  }
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

function indexCall(columns: readonly string[], isUnique: boolean, predicate?: string): IndexCall {
  return {
    columns,
    isUnique,
    ...(predicate !== undefined ? { predicate } : {}),
    unique() {
      return indexCall(columns, true, predicate);
    },
  };
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
    return value.name;
  }
  definition("sql accepts a column, a string, a number, a boolean, or null.");
}

const hiddenFields = new Set<string>();

function remember(name: string, columns: Readonly<Record<string, object>>): void {
  for (const field of Object.keys(columns)) {
    const column = columns[field] as { readonly state?: { readonly hidden?: boolean } } | undefined;
    if (column?.state?.hidden === true) hiddenFields.add(`${name}.${field}`);
  }
}
