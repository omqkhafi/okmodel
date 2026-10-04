/**
 * Row lookup by table name.
 *
 * `Register` is declaration merging on `okmodel`. `Row`, `Insert`, and
 * `Update` read it when the caller does not pass a schema. The shapes
 * themselves are computed by `table()` in the dialect.
 */

/**
 * Project schema slot.
 *
 * Augment `okmodel` with one `schema` property. `okm check` warns on a
 * second augmentation later (OKM1025).
 */
export interface Register {
  // Filled by `declare module "okmodel"`.
}

/**
 * Fields a table exposes for row lookup.
 *
 * The dialect's table value has these phantoms. This shape stays in
 * contracts so the package entry can name `Row` without importing a dialect.
 */
export type AnyTableShape = {
  readonly "~name": string;
  readonly "~row": unknown;
  readonly "~insert": unknown;
  readonly "~update": unknown;
};

/**
 * A schema that can look up tables by name.
 */
export type AnySchema = {
  readonly "~byName": { readonly [name: string]: AnyTableShape };
};

/**
 * The schema a lookup uses.
 *
 * An explicit argument wins. Otherwise the type is `Register["schema"]`.
 *
 * @typeParam S - Explicit schema, or `undefined` to read {@link Register}
 */
export type SchemaOf<S extends AnySchema | undefined> = S extends AnySchema
  ? S
  : Register extends { readonly schema: infer R extends AnySchema }
    ? R
    : never;

/**
 * Table names of a schema, defaulting to {@link Register}.
 *
 * @typeParam S - Explicit schema, or `undefined`
 */
export type TableName<S extends AnySchema | undefined = undefined> = keyof SchemaOf<S>["~byName"] &
  string;

/**
 * Row type. Hidden columns are already removed.
 *
 * @typeParam N - Table name
 * @typeParam S - Explicit schema. Omit it to use {@link Register}
 */
export type Row<N extends TableName<S>, S extends AnySchema | undefined = undefined> = ShapeOf<
  S,
  N,
  "~row"
>;

/**
 * Insert type. Guarded, generated, and primary-key columns are already removed.
 *
 * @typeParam N - Table name
 * @typeParam S - Explicit schema. Omit it to use {@link Register}
 */
export type Insert<N extends TableName<S>, S extends AnySchema | undefined = undefined> = ShapeOf<
  S,
  N,
  "~insert"
>;

/**
 * Update type. The same columns as insert, every one optional.
 *
 * @typeParam N - Table name
 * @typeParam S - Explicit schema. Omit it to use {@link Register}
 */
export type Update<N extends TableName<S>, S extends AnySchema | undefined = undefined> = ShapeOf<
  S,
  N,
  "~update"
>;

/**
 * Insert shape used when validation is on.
 *
 * The fields match {@link Insert}. The optional mark makes the two types
 * distinct, so a checked call can require this shape only while validation
 * is enabled. Guarded fields and the tenant key are already absent.
 *
 * @typeParam N - Table name
 * @typeParam S - Explicit schema. Omit it to use {@link Register}
 */
export type Input<N extends TableName<S>, S extends AnySchema | undefined = undefined> = Insert<
  N,
  S
> &
  InputMark;

/** Optional mark that distinguishes {@link Input} from {@link Insert}. */
export type InputMark = { readonly "~input"?: true };

/**
 * One phantom on the table named `N`.
 *
 * The index can include `undefined` under `noUncheckedIndexedAccess`.
 * The conditional drops that and keeps the table's own shape.
 *
 * @typeParam S - Explicit schema, or `undefined`
 * @typeParam N - Table name
 * @typeParam K - `~row`, `~insert`, or `~update`
 */
type ShapeOf<
  S extends AnySchema | undefined,
  N extends string,
  K extends keyof AnyTableShape,
> = N extends keyof SchemaOf<S>["~byName"]
  ? SchemaOf<S>["~byName"][N] extends infer T
    ? T extends AnyTableShape
      ? T[K]
      : never
    : never
  : never;
