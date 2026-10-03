/**
 * `one` and `many` relations.
 *
 * They name a table. `schema()` resolves the foreign key. An ambiguous key
 * is OKM1021. `manyThrough` arrives in 0.2. `morph` stays reserved.
 */

/** A to-one relation. `field` is the local foreign key when the table has several. */
export type OneRelation<TTable extends string = string> = {
  readonly kind: "one";
  readonly table: TTable;
  readonly field: string | undefined;
};

/** A to-many relation. `field` is the foreign key on the other table. */
export type ManyRelation<TTable extends string = string> = {
  readonly kind: "many";
  readonly table: TTable;
  readonly field: string | undefined;
};

/** A relation `table()` stores. */
export type RelationCall = OneRelation | ManyRelation;

/**
 * Declares a to-one relation by table name.
 *
 * @typeParam TTable - Related table
 * @param table - Related table name
 * @param field - Local foreign-key field, when more than one key points there
 * @returns The relation `schema()` resolves
 */
export function one<const TTable extends string>(
  table: TTable,
  field?: string,
): OneRelation<TTable> {
  return { kind: "one", table, field };
}

/**
 * Declares a to-many relation by table name.
 *
 * @typeParam TTable - Related table
 * @param table - Related table name
 * @param field - Foreign-key field on that table, when more than one key points here
 * @returns The relation `schema()` resolves
 */
export function many<const TTable extends string>(
  table: TTable,
  field?: string,
): ManyRelation<TTable> {
  return { kind: "many", table, field };
}

/**
 * Reports whether `value` is a relation helper result.
 *
 * @param value - One entry of `relations`
 * @returns `true` for `one` and `many`
 */
export function isRelationCall(value: unknown): value is RelationCall {
  if (typeof value !== "object" || value === null) return false;
  if (!("kind" in value) || !("table" in value)) return false;
  const kind = value.kind;
  return (kind === "one" || kind === "many") && typeof value.table === "string";
}
