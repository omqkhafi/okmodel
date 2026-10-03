/**
 * Runtime table model the read path compiles against.
 *
 * `schema()` fills it once. Query planning does not walk column builders again.
 */

import type { ClientFill } from "../../contracts/generator.js";

/** One column the planner can filter, select, decode, and write. */
export type ColumnModel = {
  /** Field name. */
  readonly field: string;
  /** SQL name, already checked as an identifier. */
  readonly sql: string;
  /** Catalog type, used when a value is projected through JSON. */
  readonly dataType: string;
  /** Codec encode. Identity text still returns the same string. */
  readonly encode: (value: unknown) => string;
  /**
   * Codec decode.
   *
   * Omitted when the wire text is the TypeScript value, so a row does not
   * call a codec it does not need.
   */
  readonly decode: ((wire: string) => unknown) | undefined;
  /** Excluded from a default select. Named selects still return it. */
  readonly hidden: boolean;
  /** Refused when present in insert or update input. */
  readonly guarded: boolean;
  /** Included in insert and update. Guarded, generated, and omitted columns are not. */
  readonly writable: boolean;
  /** Refused on update. Insert may still set it. A caller-supplied primary key. */
  readonly guardUpdate: boolean;
  /**
   * Catalog-output label for a client default.
   *
   * The hashed catalog does not store it. Changing the generator does not
   * change the catalog hash.
   */
  readonly clientDefault?: "client";
  /** Called once per inserted row when the field is omitted. */
  readonly fill?: ClientFill;
};

/**
 * A resolved relation.
 *
 * The join is always `related.{remote} = this.{local}`.
 */
export type RelationModel = {
  readonly name: string;
  readonly kind: "one" | "many";
  /** Related table's TypeScript name. */
  readonly table: string;
  /** SQL names on this table. */
  readonly local: readonly string[];
  /** SQL names on the related table. */
  readonly remote: readonly string[];
};

/** One table, keyed by its TypeScript name on the schema. */
export type TableModel = {
  readonly name: string;
  readonly sql: string;
  /** Primary-key field names, in catalog order. */
  readonly primary: readonly string[];
  /**
   * Field lists that `onConflict.on` may name.
   *
   * Each list is a primary key or a unique constraint. Order is the catalog order.
   */
  readonly uniques: readonly (readonly string[])[];
  readonly columns: readonly ColumnModel[];
  readonly relations: readonly RelationModel[];
};

/** Schema fields the read path and `connect()` read. */
export type QuerySchema = {
  readonly "~byName": { readonly [name: string]: { readonly "~row": unknown } };
  readonly model: Readonly<Record<string, TableModel>>;
  readonly requires?: { readonly postgres?: string } | undefined;
};
