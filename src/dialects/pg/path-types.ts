/**
 * Dotted path types for `where`, `select`, `orderBy`, `groupBy`, and `set`.
 *
 * A composite field is `"home.city"`. A to-one path is `"project.name"`, or
 * one relation and then a composite field (`"author.home.city"`). A second
 * relation is `never`, the same refusal the resolver raises (OKM1120).
 * These types are named only when a call has a key the row does not, so a
 * featureless read does not build them.
 */

import type { compositeFields } from "./composite.js";
import type { QuerySchema } from "./model.js";
import type { RowOf, RelationsOf } from "./computed-types.js";

/** `true` when `null` is part of `V`. */
type NullOf<V> = null extends V ? true : false;

/** `V | null` when the parent column or a to-one join makes the field nullable. */
type OrNull<On extends boolean, V> = On extends true ? NonNullable<V> | null : V;

/**
 * Field row of a branded composite.
 *
 * A jsonb object, a `Date`, and an array of composites are not composites:
 * the brand is a symbol key, and those types do not have it.
 */
type FieldsOf<T> =
  NonNullable<T> extends infer U
    ? typeof compositeFields extends keyof U
      ? NonNullable<U[typeof compositeFields]> extends infer Shape
        ? [unknown] extends [Shape]
          ? never
          : Shape extends Readonly<Record<string, unknown>>
            ? Shape
            : never
        : never
      : never
    : never;

/** Walks composite fields. `On` forces null from a nullable parent or a to-one join. */
type Walk<
  Shape,
  Rest extends string,
  On extends boolean,
> = Rest extends `${infer Head}.${infer Tail}`
  ? Head extends keyof Shape
    ? FieldsOf<Shape[Head]> extends infer Nested
      ? [Nested] extends [never]
        ? never
        : Walk<Nested, Tail, On extends true ? true : NullOf<Shape[Head]>>
      : never
    : never
  : Rest extends keyof Shape
    ? OrNull<On extends true ? true : NullOf<Shape[Rest]>, Shape[Rest]>
    : never;

/** One composite column's field, or `never` when `V` is not a composite. */
type FromColumn<V, Rest extends string, Force extends boolean> =
  FieldsOf<V> extends infer Shape
    ? [Shape] extends [never]
      ? never
      : Walk<Shape, Rest, Force extends true ? true : NullOf<V>>
    : never;

/** A column or a composite field of a to-one relation. The join is a left join, so the value includes null. */
type RelLeaf<
  S extends QuerySchema,
  K extends keyof S["~byName"],
  Rest extends string,
> = Rest extends `${infer Col}.${infer Tail}`
  ? Col extends keyof RowOf<S, K>
    ? FromColumn<RowOf<S, K>[Col], Tail, true>
    : never
  : Rest extends keyof RowOf<S, K>
    ? OrNull<true, RowOf<S, K>[Rest]>
    : never;

/** `"relation.column"` when `Head` is a to-one relation. Any other relation is `never`. */
type RelPath<
  S extends QuerySchema,
  K extends keyof S["~byName"],
  Head extends string,
  Rest extends string,
> = Head extends keyof RelationsOf<S, K>
  ? RelationsOf<S, K>[Head] extends {
      readonly kind: "one";
      readonly table: infer T extends string;
    }
    ? T extends keyof S["~byName"]
      ? RelLeaf<S, T, Rest>
      : never
    : never
  : never;

/**
 * The value a dotted path reads as.
 *
 * A composite field keeps the field's nullability, plus the parent column's.
 * A to-one path is always nullable. An unknown path is `never`.
 *
 * @typeParam S - Connected schema
 * @typeParam K - Table the path starts on
 * @typeParam Path - Dotted key, such as `home.city` or `author.home.city`
 */
export type PathSelect<
  S extends QuerySchema,
  K extends keyof S["~byName"],
  Path extends string,
> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof RowOf<S, K>
    ? FromColumn<RowOf<S, K>[Head], Rest, false> extends infer Hit
      ? [Hit] extends [never]
        ? RelPath<S, K, Head, Rest>
        : Hit
      : never
    : RelPath<S, K, Head, Rest>
  : never;

/**
 * The value `set` may write for a composite field.
 *
 * A to-one path is `never`. An update still replaces a composite with the
 * whole object, or sets one field of the local column.
 *
 * @typeParam S - Connected schema
 * @typeParam K - Table being updated
 * @typeParam Path - Dotted field, such as `home.city`
 */
export type PathAssign<
  S extends QuerySchema,
  K extends keyof S["~byName"],
  Path extends string,
> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof RowOf<S, K>
    ? FromColumn<RowOf<S, K>[Head], Rest, false>
    : never
  : never;
