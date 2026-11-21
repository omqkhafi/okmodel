/**
 * Row, relation, filter, and `computed` types shared by `schema()` and the read handles.
 *
 * `schema({ computed })` types its callbacks from the schema it is part of, so
 * these live below the runtime layer. The runtime types re-export them.
 */

import type { Fragment } from "./ops/fragment.js";
import type { Or, RelationFilter } from "./operators.js";
import type { QuerySchema } from "./model.js";
import type { IsTimeText } from "./time.js";
import type { FieldWhere } from "./where.js";

/** One row of a table in `S`. */
export type RowOf<S extends QuerySchema, K extends keyof S["~byName"]> = S["~byName"][K] extends {
  readonly "~row": infer R;
}
  ? R
  : never;

/** Relations declared on a table. */
export type RelationsOf<
  S extends QuerySchema,
  K extends keyof S["~byName"],
> = S["~byName"][K] extends { readonly "~relations": infer R } ? R : Record<string, never>;

/** `has`, `none`, and `every` against the related row. A morph include is not a filter. */
export type RelFilter<S extends QuerySchema, Rel> = Rel extends {
  readonly morph: { readonly targets: readonly string[] };
}
  ? never
  : Rel extends {
        readonly table: infer T extends string;
      }
    ? T extends keyof S["~byName"]
      ? RelationFilter<"has" | "none" | "every", FieldWhere<RowOf<S, T>>>
      : never
    : never;

/** Known relation names. A string index (no declared relations) adds none. */
export type RelationKeys<R> = string extends keyof R ? never : keyof R;

/** Column and relation filters for one table. */
export type FiltersOf<S extends QuerySchema, K extends keyof S["~byName"]> = FieldWhere<
  RowOf<S, K>
> & {
  readonly [R in RelationKeys<RelationsOf<S, K>>]?: RelFilter<S, RelationsOf<S, K>[R]> | undefined;
};

/** `where` for one table. `or()` may be the whole filter. */
export type WhereOf<S extends QuerySchema, K extends keyof S["~byName"]> =
  | FiltersOf<S, K>
  | Or<FiltersOf<S, K>>;

/**
 * Fields `sum` and `avg` take: those typed `number` or `string`.
 *
 * A `numeric` column is a string by default. The types cannot tell it from a
 * `text` column, so `sum` over `text` is refused when the call runs (OKM1124).
 */
export type NumericKeys<Row> = {
  readonly [F in keyof Row]-?: [NonNullable<Row[F]>] extends [number | string]
    ? IsTimeText<Row[F]> extends true
      ? never
      : F
    : never;
}[keyof Row] &
  string;

/**
 * What a `computed` callback returns for one aggregate: the value's type, carried in the type only.
 *
 * @typeParam T - What the aggregate reads as
 */
export type Computation<T> = { readonly "~computed": T };

/** The aggregates of one `many` or `manyThrough` relation. */
type ComputedHandle<S extends QuerySchema, T extends keyof S["~byName"]> = {
  /** Rows of the relation, or the distinct values of `distinct`. */
  count(options?: {
    readonly where?: WhereOf<S, T>;
    readonly distinct?: keyof RowOf<S, T> & string;
  }): Computation<number>;
  /** True when one row matches. */
  exists(options?: { readonly where?: WhereOf<S, T> }): Computation<boolean>;
  /** Total of a numeric field, or of a fragment over the related row's fields. `null` when no row matches. */
  sum<const C extends NumericKeys<RowOf<S, T>>>(
    column: C,
    options?: { readonly where?: WhereOf<S, T> },
  ): Computation<NonNullable<RowOf<S, T>[C]> | null>;
  sum(column: Fragment, options?: { readonly where?: WhereOf<S, T> }): Computation<number | null>;
  /** Average of a numeric field, or of a fragment. `null` when no row matches. */
  avg<const C extends NumericKeys<RowOf<S, T>>>(
    column: C,
    options?: { readonly where?: WhereOf<S, T> },
  ): Computation<NonNullable<RowOf<S, T>[C]> | null>;
  avg(column: Fragment, options?: { readonly where?: WhereOf<S, T> }): Computation<number | null>;
  /** Smallest value of a field, or of a fragment. `null` when no row matches. */
  min<const C extends keyof RowOf<S, T> & string>(
    column: C,
    options?: { readonly where?: WhereOf<S, T> },
  ): Computation<NonNullable<RowOf<S, T>[C]> | null>;
  min(column: Fragment, options?: { readonly where?: WhereOf<S, T> }): Computation<number | null>;
  /** Largest value of a field, or of a fragment. `null` when no row matches. */
  max<const C extends keyof RowOf<S, T> & string>(
    column: C,
    options?: { readonly where?: WhereOf<S, T> },
  ): Computation<NonNullable<RowOf<S, T>[C]> | null>;
  max(column: Fragment, options?: { readonly where?: WhereOf<S, T> }): Computation<number | null>;
};

/** The related table of a `many` or `manyThrough` relation. A one or morph relation gives `never`. */
type ManyTable<S extends QuerySchema, Rel> = Rel extends {
  readonly morph: { readonly targets: readonly string[] };
}
  ? never
  : Rel extends { readonly kind: "many"; readonly table: infer T extends keyof S["~byName"] }
    ? T
    : never;

/** The row a `computed` callback receives. Each `many` relation holds its aggregates. */
export type ComputedRow<S extends QuerySchema, K extends keyof S["~byName"]> = {
  readonly [
    R in RelationKeys<RelationsOf<S, K>> as [ManyTable<S, RelationsOf<S, K>[R]>] extends [never]
      ? never
      : R
  ]: ComputedHandle<S, ManyTable<S, RelationsOf<S, K>[R]>>;
};

/** One declared value: a callback of the row, as `computed` takes it. */
type DeclaredValue<S extends QuerySchema, K extends string> = (
  row: ComputedRow<S, K & keyof S["~byName"]>,
) => Computation<unknown> | Fragment;

/**
 * `schema({ computed })`: table name, then value name, to a callback of the row.
 *
 * The names come from the tables, not from `S`, so declaring one does not
 * resolve the key list of every table.
 *
 * @typeParam S - The schema the callbacks read
 * @typeParam N - The table names
 */
export type DeclaredComputed<S extends QuerySchema, N extends string> = {
  readonly [K in N]?: { readonly [name: string]: DeclaredValue<S, K> };
};

/**
 * `unknown` when every key of `C` is a table name, otherwise `never`: a key that is not a table is a type error.
 *
 * One check on the key union. It does not build a type per key.
 *
 * @typeParam C - The declared object
 * @typeParam N - The table names
 */
export type KnownTables<C, N extends string> = [keyof C] extends [N] ? unknown : never;
