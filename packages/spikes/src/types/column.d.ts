/**
 * Column builders for the types spike.
 *
 * The stored column is three phantom fields. The builder class exists so call
 * chains (`nullable`, `default`, `picklist`) can change those fields. An
 * extension calls {@link defineColumn} and does not change this file.
 */
/** Boolean flags that decide row, insert, and update shapes. */
export type ColumnFlags = {
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  readonly generated: boolean;
  readonly id: boolean;
  readonly hidden: boolean;
  readonly guarded: boolean;
};
/**
 * Phantom column.
 *
 * @typeParam TValue - TypeScript value stored in a row
 * @typeParam TFlags - Nullability, defaults, generation, and exposure
 * @typeParam TReference - Referenced table name, or `undefined` when there is none
 */
export type Column<
  TValue,
  TFlags extends ColumnFlags,
  TReference extends string | undefined = undefined,
> = {
  readonly "~value": TValue;
  readonly "~flags": TFlags;
  readonly "~references": TReference;
};
/** Flags for a required column with no default. */
export declare const plainFlags: {
  readonly nullable: false;
  readonly hasDefault: false;
  readonly generated: false;
  readonly id: false;
  readonly hidden: false;
  readonly guarded: false;
};
/** Flag object for {@link plainFlags}. */
export type PlainFlags = typeof plainFlags;
/** Flags for {@link t.id}. Primary keys are omitted from insert and update. */
export declare const idFlags: {
  readonly nullable: false;
  readonly hasDefault: false;
  readonly generated: false;
  readonly id: true;
  readonly hidden: false;
  readonly guarded: false;
};
/** Flag object for {@link idFlags}. */
export type IdFlags = typeof idFlags;
/**
 * Sets one flag to `true` and leaves the rest.
 *
 * @typeParam TFlags - Current flags
 * @typeParam K - Flag to turn on
 */
export type FlagTrue<TFlags extends ColumnFlags, K extends keyof ColumnFlags> = {
  readonly [P in keyof TFlags]: P extends K ? true : TFlags[P];
};
/**
 * Marks a column generated, which also counts as having a default.
 *
 * @typeParam TFlags - Current flags
 */
export type WithGenerated<TFlags extends ColumnFlags> = {
  readonly [P in keyof TFlags]: P extends "generated" | "hasDefault" ? true : TFlags[P];
};
/**
 * Chainable column builder.
 *
 * Callers see this type. {@link table} stores the phantom {@link Column}.
 *
 * @typeParam TValue - TypeScript value stored in a row
 * @typeParam TFlags - Nullability, defaults, generation, and exposure
 * @typeParam TReference - Referenced table name, or `undefined`
 */
export declare class ColumnBuilder<
  TValue,
  TFlags extends ColumnFlags,
  TReference extends string | undefined = undefined,
> {
  /** Phantom value. Present so the class carries `TValue`. */
  readonly "~value": TValue;
  /** Phantom flags. */
  readonly "~flags": TFlags;
  /** Phantom reference target. */
  readonly "~references": TReference;
  /**
   * Allows SQL NULL. The row type becomes `T | null`.
   *
   * @returns The same column, nullable
   */
  nullable(): ColumnBuilder<TValue, FlagTrue<TFlags, "nullable">, TReference>;
  /**
   * Makes the column optional on insert.
   *
   * @param _value - Default value; only its type is used
   * @returns The same column, with a default
   */
  default(
    _value: TFlags["nullable"] extends true ? TValue | null : TValue,
  ): ColumnBuilder<TValue, FlagTrue<TFlags, "hasDefault">, TReference>;
  /**
   * Omits the column from insert and update. The row type still includes it.
   *
   * @returns The same column, generated
   */
  generated(): ColumnBuilder<TValue, WithGenerated<TFlags>, TReference>;
  /**
   * Wraps the value in a readonly array. Nullability stays on the column.
   *
   * @returns An array column
   */
  array(): ColumnBuilder<readonly TValue[], TFlags, TReference>;
  /**
   * Narrows a string column to a literal union.
   *
   * @param _values - Allowed literals
   * @returns The column typed as that union
   */
  picklist<const TValues extends readonly (TValue & string)[]>(
    _values: TValues,
  ): ColumnBuilder<TValues[number], TFlags, TReference>;
  /**
   * Records a reference to a table name. It does not import that table.
   *
   * @param _table - Table name in the same schema
   * @returns The same column, with a reference target
   */
  references<const TTable extends string>(_table: TTable): ColumnBuilder<TValue, TFlags, TTable>;
  /**
   * Excludes the column from the default row type.
   *
   * @returns The same column, hidden
   */
  hidden(): ColumnBuilder<TValue, FlagTrue<TFlags, "hidden">, TReference>;
  /**
   * Omits the column from insert and update input.
   *
   * @returns The same column, guarded
   */
  guarded(): ColumnBuilder<TValue, FlagTrue<TFlags, "guarded">, TReference>;
}
/**
 * Starts a column an extension can brand.
 *
 * Core does not name the extension. The caller supplies the value type.
 *
 * @typeParam TValue - Extension value type
 * @typeParam TFlags - Column flags
 * @returns A builder the extension can return from its own function
 */
export declare function defineColumn<TValue, TFlags extends ColumnFlags>(): ColumnBuilder<
  TValue,
  TFlags,
  undefined
>;
/**
 * Postgres column builders used by the spike.
 *
 * Lengths and SQL expressions are not stored. Only the TypeScript shape is.
 */
export declare const t: {
  /**
   * Branded primary key. Insert and update omit it.
   *
   * @returns An id column
   */
  id(): ColumnBuilder<string, IdFlags, undefined>;
  /**
   * UUID text.
   *
   * @returns A uuid column
   */
  uuid(): ColumnBuilder<string, PlainFlags, undefined>;
  /**
   * Unbounded text.
   *
   * @returns A text column
   */
  text(): ColumnBuilder<string, PlainFlags, undefined>;
  /**
   * Bounded text. The length is not part of the TypeScript type.
   *
   * @param _length - Character limit
   * @returns A string column
   */
  varchar(_length: number): ColumnBuilder<string, PlainFlags, undefined>;
  /**
   * 32-bit integer.
   *
   * @returns A number column
   */
  integer(): ColumnBuilder<number, PlainFlags, undefined>;
  /**
   * 16-bit integer.
   *
   * @returns A number column
   */
  smallint(): ColumnBuilder<number, PlainFlags, undefined>;
  /**
   * 64-bit integer. The spike uses the string codec.
   *
   * @returns A string column
   */
  bigint(): ColumnBuilder<string, PlainFlags, undefined>;
  /**
   * Double precision float.
   *
   * @returns A number column
   */
  double(): ColumnBuilder<number, PlainFlags, undefined>;
  /**
   * Exact numeric. The spike uses the string codec.
   *
   * @returns A string column
   */
  numeric(): ColumnBuilder<string, PlainFlags, undefined>;
  /**
   * Boolean.
   *
   * @returns A boolean column
   */
  boolean(): ColumnBuilder<boolean, PlainFlags, undefined>;
  /**
   * Timestamp with time zone. The spike stores an ISO string, not Temporal.
   *
   * @returns A string column
   */
  timestamptz(): ColumnBuilder<string, PlainFlags, undefined>;
  /**
   * JSON value.
   *
   * @typeParam TJson - JSON shape
   * @returns A JSON column
   */
  json<TJson>(): ColumnBuilder<TJson, PlainFlags, undefined>;
  /**
   * Byte array.
   *
   * @returns A bytea column
   */
  bytea(): ColumnBuilder<Uint8Array, PlainFlags, undefined>;
  /**
   * String enum. The database name is kept so two enums stay distinct.
   *
   * @param _name - Postgres enum name
   * @param _values - Allowed literals
   * @returns A literal-union column
   */
  enum<const TName extends string, const TValues extends readonly string[]>(
    _name: TName,
    _values: TValues,
  ): ColumnBuilder<TValues[number], PlainFlags, undefined> & {
    readonly "~enum": TName;
  };
};
