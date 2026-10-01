/**
 * `table()` and the row, insert, and update types derived from its columns.
 */
import { type Column, type ColumnBuilder, type ColumnFlags } from "./column.js";
/**
 * Branded primary key for one table.
 *
 * @typeParam TName - Table name
 */
export type TableId<TName extends string> = string & {
  readonly "~table": TName;
};
/**
 * Any stored column.
 *
 * Wide on purpose so a specific column is assignable to it.
 */
export type AnyColumn = Column<unknown, ColumnFlags, string | undefined>;
/**
 * Table value produced by {@link table}.
 *
 * @typeParam TName - Table name
 * @typeParam TColumns - Stored columns
 * @typeParam TTraits - Trait names declared on the table
 */
export type Table<
  TName extends string,
  TColumns extends {
    readonly [K in keyof TColumns]: AnyColumn;
  },
  TTraits extends readonly string[],
> = {
  readonly "~name": TName;
  readonly "~columns": TColumns;
  readonly "~traits": TTraits;
  readonly "~row": RowFromColumns<TColumns>;
  readonly "~insert": InsertFromColumns<TColumns>;
  readonly "~update": UpdateFromColumns<TColumns>;
};
/**
 * A table value.
 *
 * Structural so a specific {@link Table} satisfies it. The wide column index
 * signature is not required.
 */
export type AnyTable = {
  readonly "~name": string;
  readonly "~columns": object;
  readonly "~traits": readonly string[];
  readonly "~row": unknown;
  readonly "~insert": unknown;
  readonly "~update": unknown;
};
/**
 * Copies builder type arguments onto a phantom column.
 *
 * @typeParam TColumns - Object of {@link ColumnBuilder} values
 */
export type StoreColumns<TColumns> = {
  readonly [K in keyof TColumns]: StoreColumn<TColumns[K]>;
};
/**
 * One builder, stored as a phantom column. Id columns become {@link TableId}.
 *
 * @typeParam TBuilder - Builder or enum builder intersection
 * @typeParam TName - Owning table name
 */
export type StoreColumn<TBuilder, TName extends string = string> =
  TBuilder extends ColumnBuilder<infer TValue, infer TFlags, infer TReference>
    ? TFlags extends {
        readonly id: true;
      }
      ? Column<TableId<TName>, TFlags, TReference>
      : Column<TValue, TFlags, TReference>
    : never;
/**
 * Row shape. Hidden columns are dropped. Nullable columns include `null`.
 *
 * @typeParam TColumns - Stored columns
 */
export type RowFromColumns<TColumns> = {
  readonly [K in keyof TColumns as Flag<TColumns[K], "hidden"> extends true ? never : K]: RowValue<
    TColumns[K]
  >;
};
/**
 * Insert shape. Generated, guarded, and id columns are omitted.
 * Nullable columns and columns with defaults are optional.
 *
 * @typeParam TColumns - Stored columns
 */
export type InsertFromColumns<TColumns> = {
  readonly [K in keyof TColumns as InsertKind<TColumns[K]> extends "required" ? K : never]: ValueOf<
    TColumns[K]
  >;
} & {
  readonly [
    K in keyof TColumns as InsertKind<TColumns[K]> extends "optional" ? K : never
  ]?: WriteValue<TColumns[K]>;
};
/**
 * Update shape. Same omissions as insert. Every remaining column is optional.
 *
 * @typeParam TColumns - Stored columns
 */
export type UpdateFromColumns<TColumns> = {
  readonly [K in keyof TColumns as InsertKind<TColumns[K]> extends "omit" ? never : K]?: WriteValue<
    TColumns[K]
  >;
};
/**
 * Reads one flag from a stored column.
 *
 * @typeParam TColumn - Stored column
 * @typeParam K - Flag name
 */
export type Flag<TColumn, K extends keyof ColumnFlags> =
  TColumn extends Column<unknown, infer TFlags, string | undefined> ? TFlags[K] : false;
/**
 * Value stored on the column, after id branding.
 *
 * @typeParam TColumn - Stored column
 */
export type ValueOf<TColumn> =
  TColumn extends Column<infer TValue, ColumnFlags, string | undefined> ? TValue : never;
/**
 * Value written by a caller. Nullable columns also accept `null`.
 *
 * @typeParam TColumn - Stored column
 */
export type WriteValue<TColumn> =
  Flag<TColumn, "nullable"> extends true ? ValueOf<TColumn> | null : ValueOf<TColumn>;
/**
 * Row value. Nullable columns include `null`.
 *
 * @typeParam TColumn - Stored column
 */
export type RowValue<TColumn> = WriteValue<TColumn>;
/**
 * How a column participates in insert.
 *
 * `omit` drops it. `optional` puts `?` on the property. `required` keeps it.
 */
export type InsertKind<TColumn> =
  Flag<TColumn, "generated"> extends true
    ? "omit"
    : Flag<TColumn, "guarded"> extends true
      ? "omit"
      : Flag<TColumn, "id"> extends true
        ? "omit"
        : Flag<TColumn, "hasDefault"> extends true
          ? "optional"
          : Flag<TColumn, "nullable"> extends true
            ? "optional"
            : "required";
/**
 * Reference target on a column, or `never` when it has none.
 *
 * @typeParam TColumn - Stored column
 */
export type ColumnReference<TColumn> =
  TColumn extends Column<unknown, ColumnFlags, infer TReference>
    ? [TReference] extends [string]
      ? TReference
      : never
    : never;
/**
 * Declares a table.
 *
 * The return type is the row math. The function does not talk to a database.
 *
 * @param name - Table name
 * @param columns - Column builders
 * @param options - Trait names. The spike records them and does not apply them
 * @returns The table type
 */
export declare function table<
  const TName extends string,
  const TColumns,
  const TTraits extends readonly string[] = [],
>(
  name: TName,
  columns: TColumns,
  options?: {
    readonly traits?: TTraits;
  },
): Table<TName, NamedColumns<TName, TColumns>, TTraits>;
/**
 * Stored columns with id values branded by the table name.
 *
 * @typeParam TName - Table name
 * @typeParam TColumns - Builder object passed to {@link table}
 */
export type NamedColumns<TName extends string, TColumns> = {
  readonly [K in keyof TColumns]: StoreColumn<TColumns[K], TName>;
};
