/**
 * `schema()` plus row lookup by table name.
 *
 * `Row`, `Insert`, and `Update` require an explicit schema here. The package
 * entry adds the `Register` default.
 */

import { type AnyTable, type ColumnReference } from "./table.js";

/**
 * Schema value produced by {@link schema}.
 *
 * @typeParam TTables - Tables in declaration order
 * @typeParam TExtensions - Merged extension type maps
 */
export type Schema<TTables extends readonly AnyTable[], TExtensions = EmptyExtensions> = {
  readonly "~byName": ByName<TTables>;
  readonly "~missingRefs": MissingRefs<TTables>;
  readonly "~extensions": TExtensions;
};

/** Schema whose tables can be looked up by name. */
export type AnySchema = {
  readonly "~byName": { readonly [name: string]: AnyTable };
  readonly "~missingRefs": unknown;
  readonly "~extensions": object;
};

/** Extension type map when `schema()` lists no extensions. */
export type EmptyExtensions = Record<string, never>;

/**
 * An extension definition contributed without editing core.
 *
 * @typeParam TName - Extension name
 * @typeParam TTypes - TypeScript types the extension adds
 */
export type Extension<TName extends string, TTypes extends object> = {
  readonly name: TName;
  readonly types: TTypes;
};

/** Any extension definition. */
export type AnyExtension = Extension<string, object>;

/**
 * Builds an extension definition.
 *
 * The type map is phantom. Core stores it and does not name the extension.
 *
 * @typeParam TName - Extension name
 * @typeParam TTypes - Types the extension contributes
 * @returns The definition
 */
export function extension<const TName extends string, TTypes extends object>(): Extension<
  TName,
  TTypes
> {
  return undefined as never;
}

/**
 * Groups tables and extensions.
 *
 * A reference to an unknown table fails the call: the argument must then carry
 * `~missing`. Valid references infer the table tuple and return a schema.
 *
 * @param config - Tables and optional extensions
 * @returns The schema type
 */
export function schema<
  const TTables extends readonly AnyTable[],
  const TExtensions extends readonly AnyExtension[] = [],
>(
  config: {
    readonly tables: TTables;
    readonly extensions?: TExtensions;
  } & RefCheck<TTables>,
): Schema<TTables, MergeExtensionTypes<TExtensions>> {
  return config as never;
}

/**
 * Table names on a schema.
 *
 * @typeParam S - Schema
 */
export type TableName<S extends AnySchema> = keyof S["~byName"] & string;

/**
 * Row type for one table in a schema.
 *
 * @typeParam N - Table name
 * @typeParam S - Schema
 */
export type Row<N extends TableName<S>, S extends AnySchema> = S["~byName"][N]["~row"];

/**
 * Insert type for one table in a schema.
 *
 * @typeParam N - Table name
 * @typeParam S - Schema
 */
export type Insert<N extends TableName<S>, S extends AnySchema> = S["~byName"][N]["~insert"];

/**
 * Update type for one table in a schema.
 *
 * @typeParam N - Table name
 * @typeParam S - Schema
 */
export type Update<N extends TableName<S>, S extends AnySchema> = S["~byName"][N]["~update"];

/**
 * Maps table names to tables. Later duplicates overwrite earlier ones.
 *
 * @typeParam TTables - Table tuple
 */
export type ByName<TTables extends readonly AnyTable[]> = {
  readonly [T in TTables[number] as T["~name"] & string]: T;
};

/**
 * Reference targets that are not table names in the same tuple.
 *
 * `never` means every reference resolves.
 *
 * @typeParam TTables - Table tuple
 */
export type MissingRefs<TTables extends readonly AnyTable[]> = Exclude<
  TableReferences<TTables[number]>,
  TTables[number]["~name"]
>;

/**
 * Extra argument required when a reference does not resolve.
 *
 * @typeParam TTables - Table tuple
 */
export type RefCheck<TTables extends readonly AnyTable[]> = [MissingRefs<TTables>] extends [never]
  ? unknown
  : { readonly "~missing": MissingRefs<TTables> };

/**
 * Reference names used by one table.
 *
 * @typeParam TTable - Table
 */
export type TableReferences<TTable extends AnyTable> = ColumnReference<
  TTable["~columns"][keyof TTable["~columns"]]
>;

/**
 * Intersects the type maps of every extension.
 *
 * An empty list contributes no keys.
 *
 * @typeParam TExtensions - Extension tuple
 */
export type MergeExtensionTypes<TExtensions extends readonly AnyExtension[]> =
  TExtensions["length"] extends 0
    ? EmptyExtensions
    : UnionToIntersection<TExtensions[number]["types"]>;

/**
 * Collapses a union of object types into one object type.
 *
 * @typeParam TUnion - Union to intersect
 */
export type UnionToIntersection<TUnion> = (
  TUnion extends unknown ? (argument: TUnion) => void : never
) extends (argument: infer TIntersection) => void
  ? TIntersection
  : never;

/**
 * Walks a tuple of names and returns the first repeated name.
 *
 * Recursive on purpose. The scale fixtures do not use it; a measurement asks
 * where the recursion stops.
 *
 * @typeParam TNames - Names in order
 * @typeParam TSeen - Names already visited
 */
export type DuplicateNames<
  TNames extends readonly string[],
  TSeen = never,
> = TNames extends readonly [infer THead extends string, ...infer TRest extends readonly string[]]
  ? THead extends TSeen
    ? THead
    : DuplicateNames<TRest, TSeen | THead>
  : never;
