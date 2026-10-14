/**
 * `one`, `many`, `manyThrough`, and `morph` relations.
 *
 * They name a table. `schema()` resolves the foreign key. An ambiguous key
 * is OKM1021. `manyThrough` and `morph` carry their own resolvers, so a schema
 * that never calls one does not pay for it.
 */

import { OkmError } from "../../contracts/error.js";
import type { RelationModel } from "./model.js";
import { resolveMorph, resolveMorphMany } from "./morph.js";
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

/** A table as a morph resolver reads it. Foreign-key resolvers ignore this. */
export type RelationDescribed = {
  readonly tsName: string;
  readonly sqlName: string;
  /** Primary-key SQL names, in catalog order. */
  readonly primary: readonly string[];
  readonly byField: ReadonlyMap<
    string,
    {
      readonly field: string;
      readonly sqlName: string;
      readonly dataType: string;
      readonly nullable: boolean;
    }
  >;
  readonly bySql: ReadonlyMap<
    string,
    {
      readonly field: string;
      readonly sqlName: string;
      readonly dataType: string;
    }
  >;
  /** Relation calls stored on the table, before they are resolved. */
  readonly relationOptions: unknown;
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
  /**
   * Looks up a table's columns.
   *
   * Present when `schema()` resolves relations. A resolver that only needs
   * foreign keys ignores it. The value is the prepared table; morph narrows it.
   */
  readonly describe?: (table: string) => unknown;
  /**
   * Tenant fields tenancy added to a primary key.
   *
   * A morph id matches the key that remains. Absent when the schema has no tenancy.
   */
  readonly scopeFields?: readonly string[];
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

/**
 * A polymorphic to-one relation.
 *
 * `name` is the column stem: the table declares `${name}Type` and `${name}Id`.
 * The type column stores a target table name. The id column stores that
 * table's primary key. Include returns one row of the matching target, or
 * null, as a flat union discriminated by the type field.
 *
 * @typeParam TName - Column stem
 * @typeParam TTargets - Closed list of target tables
 * @param name - Column stem
 * @param targets - Target table names, each with one primary-key column
 * @returns The relation `schema()` resolves
 */
export function morph<
  const TName extends string,
  const TTargets extends readonly [string, ...string[]],
>(name: TName, targets: TTargets): MorphRelation<TName, TTargets> {
  if (name.length === 0) throw new OkmError("OKM1020", "morph() needs a name.");
  if (targets.length === 0) throw new OkmError("OKM1020", "morph() needs a target table.");
  for (const target of targets) {
    if (typeof target !== "string" || target.length === 0) {
      throw new OkmError("OKM1020", "morph() targets must be table names.");
    }
  }
  const list = targets;
  return {
    kind: "one",
    table: targets[0],
    field: undefined,
    morph: { name, targets, typeField: `${name}Type` },
    resolve: (scope) => resolveMorph(scope, name, list),
  } as MorphRelation<TName, TTargets>;
}

/**
 * The reverse of {@link morph}: many owner rows that point at this table.
 *
 * Declare it on each target. `table` is the table that holds the type and id
 * columns, and `name` is the stem passed to `morph`.
 *
 * @typeParam TTable - Table that holds the type and id columns
 * @param table - That table
 * @param name - Column stem
 * @returns The relation `schema()` resolves
 */
export function morphMany<const TTable extends string>(
  table: TTable,
  name: string,
): MorphManyRelation<TTable> {
  if (table.length === 0 || name.length === 0) {
    throw new OkmError("OKM1020", "morphMany() needs a table and a morph name.");
  }
  return {
    kind: "many",
    table,
    field: undefined,
    resolve: (scope) => resolveMorphMany(scope, table, name),
  };
}

/**
 * A polymorphic relation declared with {@link morph}.
 *
 * It is a {@link OneRelation} so the relation map stays assignable. `morph`
 * is what include reads to build the union.
 */
export type MorphRelation<
  TName extends string = string,
  TTargets extends readonly string[] = readonly string[],
> = OneRelation<TTargets[number]> & {
  readonly morph: {
    readonly name: TName;
    readonly targets: TTargets;
    readonly typeField: `${TName}Type`;
  };
  readonly resolve: (scope: RelationScope) => RelationModel;
};

/**
 * The reverse many declared with {@link morphMany}.
 *
 * It is a {@link ManyRelation}, so include, `has`, `none`, and `every` read it as one.
 */
export type MorphManyRelation<TTable extends string = string> = ManyRelation<TTable> & {
  readonly resolve: (scope: RelationScope) => RelationModel;
};

/**
 * Sets a morph's type and id columns together.
 *
 * @typeParam TName - Column stem
 * @typeParam TType - Target table name
 * @param name - Column stem passed to `morph`
 * @param type - Target table name
 * @param id - That table's primary key
 * @returns The two fields an insert or update spreads in
 */
export function morphTo<const TName extends string, const TType extends string>(
  name: TName,
  type: TType,
  id: string,
): { readonly [K in `${TName}Type`]: TType } & { readonly [K in `${TName}Id`]: string } {
  if (name.length === 0 || type.length === 0) {
    throw new OkmError("OKM1020", "morphTo() needs a morph name and a target table.");
  }
  const row: Record<string, string> = {};
  row[`${name}Type`] = type;
  row[`${name}Id`] = id;
  return row as { readonly [K in `${TName}Type`]: TType } & {
    readonly [K in `${TName}Id`]: string;
  };
}
