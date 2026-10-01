/**
 * Public entry for the types spike.
 *
 * `Row`, `Insert`, and `Update` default the schema to `Register["schema"]`.
 * Pass a schema argument to ignore that default. Nothing here is published.
 */

import {
  type AnySchema,
  type Insert as InsertOf,
  type Row as RowOf,
  type TableName as TableNameOf,
  type Update as UpdateOf,
} from "./schema.js";
import { type AnyTable } from "./table.js";

export {
  type Column,
  type ColumnBuilder,
  type ColumnFlags,
  type FlagTrue,
  type PlainFlags,
  type WithGenerated,
  defineColumn,
  idFlags,
  plainFlags,
  t,
} from "./column.js";
export {
  ArchiveCrud,
  Crud,
  type Id,
  type TableShapes,
  type TablesWith,
  type TablesWithColumn,
  tableShapes,
} from "./generics.js";
export {
  type AnySchema,
  type ByName,
  type DuplicateNames,
  type EmptyExtensions,
  type Extension,
  type MergeExtensionTypes,
  type MissingRefs,
  type RefCheck,
  schema,
  type Schema,
  type UnionToIntersection,
  extension,
} from "./schema.js";
export {
  type AnyColumn,
  type AnyTable,
  type ColumnReference,
  type Flag,
  type InsertFromColumns,
  type InsertKind,
  type NamedColumns,
  type RowFromColumns,
  type RowValue,
  type StoreColumn,
  type StoreColumns,
  type Table,
  type TableId,
  type UpdateFromColumns,
  type ValueOf,
  type WriteValue,
  table,
} from "./table.js";
export { type Citext, citext, citextExtension } from "./extensions/citext.js";
export { appSchema } from "./register-schema.js";
export { tasks } from "./register-tasks.js";
export { users } from "./register-users.js";

/**
 * Project schema slot. Augment this module to set `schema`.
 */
export interface Register {}

/**
 * Per-file table slot. Augment this module to add a table property.
 */
export interface RegisteredTables {}

/**
 * Schema from `Register`, or the explicit argument when one is passed.
 *
 * @typeParam S - Explicit schema, or `undefined` to read `Register`
 */
export type SchemaOf<S extends AnySchema | undefined> = S extends AnySchema
  ? S
  : Register extends { readonly schema: infer R extends AnySchema }
    ? R
    : never;

/**
 * Table names of a schema, defaulting to `Register`.
 *
 * @typeParam S - Explicit schema, or `undefined`
 */
export type TableName<S extends AnySchema | undefined = undefined> = TableNameOf<SchemaOf<S>>;

/**
 * Row type. Hidden columns are already removed.
 *
 * @typeParam N - Table name
 * @typeParam S - Explicit schema. Omit it to use `Register`
 */
export type Row<N extends TableName<S>, S extends AnySchema | undefined = undefined> = RowOf<
  N,
  SchemaOf<S>
>;

/**
 * Insert type. Guarded, generated, and id columns are already removed.
 *
 * @typeParam N - Table name
 * @typeParam S - Explicit schema. Omit it to use `Register`
 */
export type Insert<N extends TableName<S>, S extends AnySchema | undefined = undefined> = InsertOf<
  N,
  SchemaOf<S>
>;

/**
 * Update type.
 *
 * @typeParam N - Table name
 * @typeParam S - Explicit schema. Omit it to use `Register`
 */
export type Update<N extends TableName<S>, S extends AnySchema | undefined = undefined> = UpdateOf<
  N,
  SchemaOf<S>
>;

/**
 * Row type of a table registered by file.
 *
 * @typeParam N - Key of {@link RegisteredTables}
 */
export type RegisteredRow<N extends keyof RegisteredTables> = RegisteredTables[N] extends AnyTable
  ? RegisteredTables[N]["~row"]
  : never;
