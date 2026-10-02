/**
 * Runtime table model the read path compiles against.
 *
 * `schema()` fills it once. Query planning does not walk column builders again.
 */

/** One column the planner can filter, select, and decode. */
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
  readonly columns: readonly ColumnModel[];
  readonly relations: readonly RelationModel[];
};

/** Schema fields the read path and `connect()` read. */
export type QuerySchema = {
  readonly "~byName": { readonly [name: string]: { readonly "~row": unknown } };
  readonly model: Readonly<Record<string, TableModel>>;
  readonly requires?: { readonly postgres?: string } | undefined;
};
