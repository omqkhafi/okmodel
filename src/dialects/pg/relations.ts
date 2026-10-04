/**
 * `one`, `many`, and `manyThrough` relations.
 *
 * They name a table. `schema()` resolves the foreign key. An ambiguous key
 * is OKM1021. `manyThrough` names the join table as well and carries its own
 * resolver, so a schema without one does not pay for it. `morph` stays reserved.
 */

import type { RelationModel } from "./model.js";
import { resolveThrough } from "./through.js";

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

/** A foreign key `schema()` resolved, as a relation resolver sees it. */
export type RelationEdge = {
  readonly fromTable: string;
  readonly fromField: string;
  readonly toTable: string;
  /** Local SQL names, one column or a composite key. */
  readonly local: readonly string[];
  /** Referenced SQL names, in the same order. */
  readonly remote: readonly string[];
};

/** What a relation's own resolver reads from `schema()`. */
export type RelationScope = {
  /** The table that declares the relation. */
  readonly owner: string;
  /** The relation name. */
  readonly name: string;
  readonly edges: readonly RelationEdge[];
  /** Every table name in the schema, sorted. */
  readonly tables: readonly string[];
};

/**
 * A to-many relation through a join table.
 *
 * It is a {@link ManyRelation} to the types, so `include`, `has`, `none`, and
 * `every` read it as one. `resolve` is what `schema()` calls in place of the
 * foreign-key search that `many` uses.
 */
export type ManyThroughRelation<TTable extends string = string> = ManyRelation<TTable> & {
  /** The join table. */
  readonly through: string;
  /** Turns this declaration into a resolved model. */
  readonly resolve: (scope: RelationScope) => RelationModel;
};

/** Join-table foreign keys, named only when more than one points at a table. */
export type ThroughKeys = {
  /** The join table field that references the declaring table. */
  readonly from?: string;
  /** The join table field that references the related table. */
  readonly to?: string;
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

/**
 * Declares a to-many relation through a join table.
 *
 * The join table has one foreign key to the declaring table and one to the
 * related table. Name `from` and `to` when a table has more than one. Tenancy
 * and archivable apply to the join rows and to the related rows alike.
 *
 * @typeParam TTable - Related table
 * @param table - Related table name
 * @param options - The join table, and its foreign-key fields when ambiguous
 * @returns The relation `schema()` resolves
 */
export function manyThrough<const TTable extends string>(
  table: TTable,
  options: { readonly through: string } & ThroughKeys,
): ManyThroughRelation<TTable> {
  const { through, from, to } = options;
  return {
    kind: "many",
    table,
    field: undefined,
    through,
    resolve: (scope) => resolveThrough(scope, table, through, from, to),
  };
}
