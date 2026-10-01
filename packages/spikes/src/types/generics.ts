/**
 * Generic helpers from the types section of the spec, reduced to row shapes.
 *
 * There is no client. Methods throw. The signatures are what the spike checks.
 */

import { type AnySchema, type Insert, type Row, type TableName, type Update } from "./schema.js";
import { type AnyTable, type TableId } from "./table.js";

/**
 * Primary key type for a table name.
 *
 * @typeParam N - Table name
 */
export type Id<N extends string> = TableId<N>;

/**
 * Row, insert, and update types of one table.
 *
 * @typeParam TTable - Table
 */
export type TableShapes<TTable extends AnyTable> = {
  readonly row: TTable["~row"];
  readonly insert: TTable["~insert"];
  readonly update: TTable["~update"];
};

/**
 * Returns the three shapes of any table.
 *
 * The runtime value is unused. Callers use the return type.
 *
 * @param source - Any table
 * @returns Its row, insert, and update types
 */
export function tableShapes<TTable extends AnyTable>(source: TTable): TableShapes<TTable> {
  return source as unknown as TableShapes<TTable>;
}

/**
 * Table names on `S` that list `Trait`.
 *
 * @typeParam S - Schema
 * @typeParam Trait - Trait name
 */
export type TablesWith<S extends AnySchema, Trait extends string> = {
  readonly [K in TableName<S>]: Trait extends S["~byName"][K]["~traits"][number] ? K : never;
}[TableName<S>];

/**
 * Table names on `S` whose row type has `Col`.
 *
 * @typeParam S - Schema
 * @typeParam Col - Column name
 */
export type TablesWithColumn<S extends AnySchema, Col extends string> = {
  readonly [K in TableName<S>]: Col extends keyof S["~byName"][K]["~row"] ? K : never;
}[TableName<S>];

/**
 * Generic create, read, and update signatures for one table name.
 *
 * @typeParam S - Schema
 * @typeParam N - Table name in that schema
 */
export class Crud<S extends AnySchema, N extends TableName<S>> {
  /** Schema the names are drawn from. */
  readonly schema: S;
  /** Table name. */
  readonly name: N;

  /**
   * Binds a schema and a table name.
   *
   * @param schema - Schema that contains `name`
   * @param name - Table name
   */
  constructor(schema: S, name: N) {
    this.schema = schema;
    this.name = name;
  }

  /**
   * Reads one row by branded id.
   *
   * @param _id - Primary key
   * @returns The row type
   */
  get(_id: Id<N>): Row<N, S> {
    throw new Error("type spike");
  }

  /**
   * Inserts one row.
   *
   * @param _data - Insert input
   * @returns The row type
   */
  create(_data: Insert<N, S>): Row<N, S> {
    throw new Error("type spike");
  }

  /**
   * Patches one row.
   *
   * @param _id - Primary key
   * @param _data - Update input
   * @returns The row type
   */
  update(_id: Id<N>, _data: Update<N, S>): Row<N, S> {
    throw new Error("type spike");
  }
}

/**
 * {@link Crud} limited to tables that declare the `archivable` trait.
 *
 * @typeParam S - Schema
 * @typeParam N - Archivable table name
 */
export class ArchiveCrud<
  S extends AnySchema,
  N extends TablesWith<S, "archivable"> & TableName<S>,
> extends Crud<S, N> {
  /**
   * Binds an archivable table.
   *
   * @param schema - Schema that contains `name`
   * @param name - Archivable table name
   */
  constructor(schema: S, name: N) {
    super(schema, name);
  }

  /**
   * Archive result shape from the archive contract. No runtime.
   *
   * @param _id - Primary key
   * @returns Count and a fresh archive id
   */
  archive(_id: Id<N>): { readonly count: number; readonly archiveId: string } {
    throw new Error("type spike");
  }
}
