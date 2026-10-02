/**
 * `table()`, index calls, and check text.
 *
 * `table()` stores the columns. It does not build catalog objects.
 * `schema()` does that.
 */

import { throwNamed } from "../../contracts/error.js";
import { type ColumnInsertOf, type ColumnRowOf, type ColumnUpdateOf } from "./column.js";
import { definition, unavailable } from "./misuse.js";

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
  readonly sqlName?: string;
  readonly renamedFrom?: string;
  readonly comment?: string;
  readonly validate?: unknown;
  readonly validation?: unknown;
  readonly traits?: unknown;
  readonly omitDefaults?: unknown;
  readonly tenancy?: unknown;
  readonly relations?: unknown;
  readonly computed?: unknown;
  readonly presets?: unknown;
  readonly policies?: unknown;
  readonly reference?: unknown;
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
 */
export type Table<TName extends string, TColumns> = {
  readonly "~name": TName;
  readonly "~columns": TColumns;
  readonly "~row": RowFrom<TColumns>;
  readonly "~insert": InsertFrom<TColumns>;
  readonly "~update": UpdateFrom<TColumns>;
  readonly name: TName;
  readonly columns: TColumns;
  readonly options?: TableOptions<TColumns>;
};

/**
 * Any table `schema()` can compile.
 */
export type AnyTable = {
  readonly "~name": string;
  readonly "~row": unknown;
  readonly "~insert": unknown;
  readonly "~update": unknown;
  readonly name: string;
  readonly columns: Readonly<Record<string, object>>;
  readonly options?: object;
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
export type UpdateFrom<TColumns> = {
  readonly [
    K in keyof TColumns as ColumnUpdateOf<TColumns[K]> extends never ? never : K
  ]: ColumnUpdateOf<TColumns[K]>;
};

const TABLE_KNOWN = new Set(["checks", "comment", "indexes", "renamedFrom", "sqlName", "unique"]);

/**
 * Later table options, and the prompt that adds each one.
 *
 * `later` names no prompt: the execution plan has no row for that option.
 */
const TABLE_LATER: Readonly<Record<string, string>> = {
  computed: "later",
  omitDefaults: "P23",
  policies: "later",
  presets: "P28",
  reference: "P53A",
  relations: "P27",
  tenancy: "P24",
  traits: "P23",
  validate: "P26",
  validation: "P26",
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
>(name: TName, columns: TColumns, options?: TableOptions<TColumns>): Table<TName, TColumns> {
  if (name.length === 0) {
    definition("table() needs a name.");
  }
  if (options !== undefined) {
    rejectLater(options, TABLE_KNOWN, TABLE_LATER, `Table ${name}`);
  }
  return { name, columns, ...(options !== undefined ? { options } : {}) } as Table<TName, TColumns>;
}

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

function indexCall(columns: readonly string[], isUnique: boolean): IndexCall {
  return {
    columns,
    isUnique,
    unique() {
      return indexCall(columns, true);
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
