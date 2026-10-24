/**
 * Types for a connected client.
 *
 * Row shapes are the schema's `~row`. Operators are the tagged helpers.
 * A plain object is not a where value when the column type is an object.
 */

import type { DriverCapabilities, DriverTimeouts, Notice } from "../contracts/driver.js";
import type { SafeResult } from "../contracts/error.js";
import type { OptionalInsert, RequiredInsert } from "../contracts/rows.js";
import type { QuerySchema } from "../dialects/pg/model.js";
import type { Bucket } from "../dialects/pg/ops/bucket.js";
import type { Window } from "../dialects/pg/ops/window.js";
import type { Inc } from "../dialects/pg/ops/inc.js";
import type {
  ArrAppend,
  ArrRemove,
  JsonSet,
  Or,
  RelationFilter,
  Relevance,
  SearchMatch,
} from "../dialects/pg/operators.js";
import type { FieldWhere, IsJsonObject } from "../dialects/pg/where.js";
import type { AppliedRule, Limits, ReadCall, ReadDone, ReadOp } from "./plan.js";
import type { SessionContext, SessionValues, SettingMap } from "./session/index.js";

export type { Limits } from "./plan.js";
import type { WarningIgnore } from "./warnings/catalog.js";

export type { FieldWhere, WhereValue } from "../dialects/pg/where.js";

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

/** Array and JSON writes the column value type can accept. */
type WriteOp<V> = [unknown] extends [V]
  ? JsonSet<unknown> | ArrAppend<unknown> | ArrRemove<unknown>
  :
      | (V extends readonly (infer E)[] ? ArrAppend<E> | ArrRemove<E> : never)
      | (IsJsonObject<V> extends true ? JsonSet<unknown> : never);

/**
 * `inc` on a number or bigint column.
 *
 * A `string` column is not included. `text` is a string, and so is `numeric`
 * or `bigint` when the codec keeps the decimal text. The statement still
 * accepts `inc` on a numeric database type.
 */
type IncOf<V> = [unknown] extends [V]
  ? Inc<number> | Inc<bigint>
  : [NonNullable<V>] extends [number]
    ? Inc<number>
    : [NonNullable<V>] extends [bigint]
      ? Inc<bigint>
      : never;

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
type RelationKeys<R> = string extends keyof R ? never : keyof R;

/** The column when it is `hidden({ filterable: true })`, otherwise `never`. */
type FilterBit<C> = C extends { "~flags": { "~filter": true } } ? C : never;

/**
 * Columns `where` and `orderBy` share.
 *
 * The row, plus `hidden({ filterable: true })`. A table with none of those
 * columns keeps {@link RowOf}. The extra keys are built only for a table that
 * opted in. The check distributes over the column union.
 */
type FilterableOf<S extends QuerySchema, K extends keyof S["~byName"]> = S["~byName"][K] extends {
  "~columns": infer C;
}
  ? FilterBit<C[keyof C]> extends never
    ? RowOf<S, K>
    : RowOf<S, K> & {
        readonly [P in keyof C as FilterBit<C[P]> extends never ? never : P]: unknown;
      }
  : RowOf<S, K>;

/** Column filters plus `hidden({ filterable: true })`, and relation filters. */
type FilterFiltersOf<S extends QuerySchema, K extends keyof S["~byName"]> = FieldWhere<
  FilterableOf<S, K>
> & {
  readonly [R in RelationKeys<RelationsOf<S, K>>]?: RelFilter<S, RelationsOf<S, K>[R]> | undefined;
};

/**
 * `Shape`, plus `never` for any key `T` adds.
 *
 * Lives in a later overload's constraint, so a call an earlier overload
 * accepts does not build it. An intersection parameter would allow those keys.
 */
type ExactConstraint<T, Shape> = Shape & Record<Exclude<keyof T, keyof Shape>, never>;

/** `Fields`, plus `never` for a key `W` adds. A plain hidden column stays out. */
type ClosedWhere<W, Fields> = Fields & Record<Exclude<keyof NonNullable<W>, keyof Fields>, never>;

/** `where` for a later overload: filterable hidden columns, and no other extra key. */
type FilterWhereOf<S extends QuerySchema, K extends keyof S["~byName"], W> =
  | ClosedWhere<W, FilterFiltersOf<S, K>>
  | Or<FilterFiltersOf<S, K>>;

/** `find` options whose `where` and `orderBy` include `hidden({ filterable: true })`. */
type FindFilterOptions<S extends QuerySchema, K extends keyof S["~byName"], L> = Omit<
  FindOptions<S, K>,
  "where" | "orderBy" | "search"
> &
  L & {
    readonly where?: FilterFiltersOf<S, K> | Or<FilterFiltersOf<S, K>>;
    readonly orderBy?: OrderBy<FilterableOf<S, K>>;
    readonly search?: TextSearch<FilterableOf<S, K>>;
  };

/** `one` and `page` options with the same filterable key set. */
type ReadFilterOptions<S extends QuerySchema, K extends keyof S["~byName"]> = Omit<
  ReadOptions<S, K>,
  "where" | "orderBy"
> & {
  readonly where?: FilterFiltersOf<S, K> | Or<FilterFiltersOf<S, K>>;
  readonly orderBy?: OrderBy<FilterableOf<S, K>>;
};

/** `count` options with the same filterable key set. */
type CountFilterOptions<S extends QuerySchema, K extends keyof S["~byName"]> = CallOptions & {
  readonly where?: FilterFiltersOf<S, K> | Or<FilterFiltersOf<S, K>>;
  readonly search?: TextSearch<FilterableOf<S, K>>;
};

/** One `update` object whose `where` includes `hidden({ filterable: true })`. */
type UpdateFilterTarget<S extends QuerySchema, K extends keyof S["~byName"], W> = Omit<
  Extract<UpdateArg<S, K>, { readonly set: unknown }>,
  "where"
> & {
  readonly where?: FilterWhereOf<S, K, W>;
};

/** One `delete` object whose `where` includes `hidden({ filterable: true })`. */
type DeleteFilterTarget<S extends QuerySchema, K extends keyof S["~byName"], W> = {
  readonly where?: FilterWhereOf<S, K, W>;
};

/** Column and relation filters for one table. */
type FiltersOf<S extends QuerySchema, K extends keyof S["~byName"]> = FieldWhere<RowOf<S, K>> & {
  readonly [R in RelationKeys<RelationsOf<S, K>>]?: RelFilter<S, RelationsOf<S, K>[R]> | undefined;
};

/** `where` for one table. `or()` may be the whole filter. */
export type WhereOf<S extends QuerySchema, K extends keyof S["~byName"]> =
  | FiltersOf<S, K>
  | Or<FiltersOf<S, K>>;

/**
 * `orderBy`. `asc` is nulls last and `desc` is nulls first unless `nulls` is set.
 *
 * A `hidden({ filterable: true })` column is a key, the same set `where` uses.
 * A plain `.hidden()` column is not. The row stays the select list.
 */
export type OrderBy<Row> = {
  readonly [K in keyof Row]?:
    | "asc"
    | "desc"
    | { readonly dir: "asc" | "desc"; readonly nulls?: "first" | "last" }
    | Relevance
    | undefined;
};

/**
 * Text to look for.
 *
 * A string is enough when the table has one column built for search. `in`
 * names the column when it has more than one.
 */
export type TextSearch<Row> =
  | string
  | {
      /** Text to look for. */
      readonly for: string;
      /** Column to search. Required when the table has more than one. */
      readonly in?: keyof Row & string;
      /** How to match. Omitted means `natural`. */
      readonly match?: SearchMatch;
      /** Text search language, such as `english`. Omitted uses the database default. */
      readonly language?: string;
    };

type Related<S extends QuerySchema, T extends keyof S["~byName"], Opt> = Opt extends {
  readonly select: infer Sel;
}
  ? Selected<RowOf<S, T>, Sel>
  : RowOf<S, T>;

/** True when `connect({ limits })` set `Key`: the call may then state no limit. */
type Defaults<S, Key extends keyof Limits> = S extends {
  readonly "~limits": { readonly [P in Key]: number };
}
  ? true
  : false;

/** `limit` of a to-many include: required, or optional when `limits.include` is set. */
type IncludeLimit<S> =
  Defaults<S, "include"> extends true ? { readonly limit?: number } : { readonly limit: number };

/** One include. To-many needs `limit`, unless `limits.include` is set. A morph include is `true`. */
export type IncludeOf<S extends QuerySchema, K extends keyof S["~byName"]> = {
  readonly [R in RelationKeys<RelationsOf<S, K>>]?: RelationsOf<S, K>[R] extends {
    readonly morph: { readonly targets: readonly string[] };
  }
    ? true
    : RelationsOf<S, K>[R] extends {
          readonly kind: "many";
          readonly table: infer T extends string;
        }
      ? T extends keyof S["~byName"]
        ?
            | (Defaults<S, "include"> extends true ? true : never)
            | (IncludeLimit<S> & {
                readonly select?: readonly (keyof RowOf<S, T> & string)[];
                readonly where?: FieldWhere<RowOf<S, T>>;
                readonly orderBy?: OrderBy<RowOf<S, T>>;
              })
        : never
      : RelationsOf<S, K>[R] extends {
            readonly kind: "one";
            readonly table: infer T extends string;
          }
        ? T extends keyof S["~byName"]
          ?
              | true
              | {
                  readonly select?: readonly (keyof RowOf<S, T> & string)[];
                  readonly where?: FieldWhere<RowOf<S, T>>;
                  readonly orderBy?: OrderBy<RowOf<S, T>>;
                }
          : never
        : never;
};

/**
 * Rows a morph include can return.
 *
 * Each target's row, plus the type field set to that table name, or null when
 * the target row is missing.
 */
/** Flattens an intersection so a morph arm is one object type. */
type Flat<T> = { readonly [K in keyof T]: T[K] };

/** One arm of a morph union. Distributes over the closed target list. */
type MorphArm<
  S extends QuerySchema,
  T extends string,
  Field extends string,
> = T extends keyof S["~byName"] ? Flat<RowOf<S, T> & { readonly [P in Field]: T }> : never;

type MorphUnion<
  S extends QuerySchema,
  Targets extends readonly string[],
  Field extends string,
> = MorphArm<S, Targets[number], Field> | null;

/** Columns kept by `select`. The full row when `select` is omitted. */
export type Selected<Row, Sel> = [Sel] extends [readonly (infer P)[]]
  ? [P] extends [keyof Row]
    ? { readonly [K in P & keyof Row]: Row[K] }
    : boolean extends HasWindow<P>
      ? Pick<Row, Extract<P, keyof Row>> & WindowFields<Row, P>
      : [P] extends [Window<string, string | number>]
        ? WindowFields<Row, P>
        : Row
  : Row;

/** `true` when a select entry is a window. A mix of fields and windows is `boolean`. */
type HasWindow<P> = P extends Window<string, string | number> ? true : false;

/** Result keys a window helper adds. A field name contributes nothing. */
type WindowFields<Row, P> = Intersect<
  P extends Window<infer A, infer V>
    ? {
        readonly [K in A]: V extends keyof Row
          ? NonNullable<Row[V]> | null
          : V extends number
            ? number
            : string;
      }
    : {}
>;

type IncludeRows<S extends QuerySchema, K extends keyof S["~byName"], Inc> = [Inc] extends [
  Record<string, unknown>,
]
  ? {
      readonly [R in keyof Inc & keyof RelationsOf<S, K>]: RelationsOf<S, K>[R] extends {
        readonly morph: {
          readonly targets: infer Targets extends readonly string[];
          readonly typeField: infer Field extends string;
        };
      }
        ? MorphUnion<S, Targets, Field>
        : RelationsOf<S, K>[R] extends {
              readonly kind: "many";
              readonly table: infer T extends keyof S["~byName"];
            }
          ? readonly Related<S, T, Inc[R]>[]
          : RelationsOf<S, K>[R] extends {
                readonly kind: "one";
                readonly table: infer T extends keyof S["~byName"];
              }
            ? Related<S, T, Inc[R]> | null
            : never;
    }
  : unknown;

/**
 * Rewrites a row so an editor shows the fields.
 *
 * A key-remapped alias such as `RowFrom` stays collapsed in hover and prints
 * the column builders. This mapped type is what quickinfo expands.
 */
type Show<T> = { [K in keyof T]: T[K] } & {};

/** Find or one row, plus includes. */
export type ResultRow<S extends QuerySchema, K extends keyof S["~byName"], O> = Show<
  Selected<RowOf<S, K>, O extends { readonly select: infer Sel } ? Sel : undefined> &
    IncludeRows<S, K, O extends { readonly include: infer Inc } ? Inc : undefined>
>;

/** Per-call cancellation and deadline (spec §15). */
export type CallOptions = {
  /** Aborts the call. The statement is cancelled where the driver can, and the call fails as `cancelled`. */
  readonly signal?: AbortSignal;
  /** Milliseconds. The call fails as `timeout` when it runs longer. */
  readonly timeout?: number;
  /**
   * Forces this read onto the primary or a replica.
   *
   * Absent, a topology client chooses. A single endpoint serves either value.
   */
  readonly route?: "primary" | "replica";
};

/** One warning ignore, or a list of them. `reason` is required on each. */
type CallIgnore = WarningIgnore | readonly WarningIgnore[];

/** Options shared by reads. */
export type ReadOptions<S extends QuerySchema, K extends keyof S["~byName"]> = CallOptions & {
  readonly where?: WhereOf<S, K>;
  /** Field names, or a window helper (`rowNumber`, `rank`, `denseRank`, `runningTotal`). */
  readonly select?: readonly ((keyof RowOf<S, K> & string) | Window<string, string | number>)[];
  readonly orderBy?: OrderBy<RowOf<S, K>>;
  readonly include?: IncludeOf<S, K>;
  /** Suppress a warning rule. Absent when every firing rule should report. */
  readonly ignore?: CallIgnore;
};

/**
 * Row locks on `find`. They exist inside `tx()` only (OKM1830 outside one).
 *
 * `wait` says what happens when a row is locked by another transaction: `nowait`
 * fails at once (kind `lock_timeout`) and `skip` leaves that row out.
 * `lock: "skip"` is not a read lock. It claims rows on `update`.
 */
export type LockOptions = {
  readonly lock?: "update" | "share";
  readonly wait?: "nowait" | "skip";
};

/** `find` options. `limit` is required unless the caller uses `.all(reason)`. */
export type FindOptions<S extends QuerySchema, K extends keyof S["~byName"]> = ReadOptions<S, K> & {
  readonly limit?: number;
  /** Rows to skip. An integer from 0 up. */
  readonly offset?: number;
  /** Text to look for. The closest matches come first unless `orderBy` is set. */
  readonly search?: TextSearch<RowOf<S, K>>;
  /**
   * One row per different combination of the selected fields. Needs `select`.
   * `orderBy` may name selected fields only. Not with `include` or `search`.
   */
  readonly distinct?: true;
  /**
   * Postgres. The first row of each key under `orderBy`, which must start with
   * the same keys. Not with `distinct`, `include`, or `search`.
   */
  readonly distinctOn?: readonly (keyof RowOf<S, K> & string)[];
};

/**
 * Options for `descendants` and `ancestors`.
 *
 * `depth` is how many steps from the starting row. Omit it to walk the whole
 * tree. `self` includes that row. `relation` names which self-relation when
 * the table has more than one.
 */
export type TreeOptions<S extends QuerySchema, K extends keyof S["~byName"]> = CallOptions & {
  readonly where?: WhereOf<S, K>;
  readonly select?: readonly (keyof RowOf<S, K> & string)[];
  readonly orderBy?: OrderBy<RowOf<S, K>>;
  /** Suppress a warning rule. Absent when every firing rule should report. */
  readonly ignore?: CallIgnore;
  readonly depth?: number;
  /** Include the starting row. Omitted leaves it out. */
  readonly self?: boolean;
  /** Which self-relation. Required when the table has more than one. */
  readonly relation?: string;
};

/** Links `sync` added and removed. Values are the related row's primary key. */
export type SyncResult = {
  readonly added: readonly unknown[];
  readonly removed: readonly unknown[];
};

/** Options for `sync`. `expect` matches an update: the count is links added plus links removed. */
export type SyncOptions = CallOptions & {
  readonly expect?: number;
};

/** The handle `sync` returns. */
export type SyncHandle = Promise<SyncResult> & {
  /** The statement, before it runs. */
  sql(): Promise<{
    readonly statements: readonly {
      readonly text: string;
      readonly params?: readonly (string | null)[];
    }[];
  }>;
  /** `{ ok, value }` or `{ ok, error }`. */
  safe(): Promise<SafeResult<SyncResult>>;
  /** Throws `not_found` when the number of added and removed links is not `count`. */
  expect(count: number): SyncHandle;
};

/** A query handle. Await it, or inspect it before it runs. */
export type Query<T> = Promise<T> & {
  /** Logical intent, rules, plan, SQL, parameters, and the routing decision. */
  inspect(): Inspection | Promise<Inspection>;
  /** Statement text and parameters. */
  sql():
    | { readonly text: string; readonly params: readonly (string | null)[] }
    | Promise<{ readonly text: string; readonly params: readonly (string | null)[] }>;
  /** `{ ok, value }` or `{ ok, error }`. */
  safe(): Promise<SafeResult<T>>;
};

/** The handle `find`, `one`, `count`, and `exists` return. */
export type Read<T> = Query<T> & {
  /** Allows `find` or a to-many include without `limit`. */
  all(reason: string): Read<T>;
  /** Turns a null `one()` into `not_found`. */
  required(): Read<NonNullable<T>>;
  /**
   * Yields rows in keyset batches on every driver.
   *
   * `batch` is how many rows one query fetches. The default is 1000.
   * `limit` on the find is the total. A table with no primary key is OKM1120.
   */
  stream(options?: {
    readonly batch?: number;
  }): AsyncIterable<T extends readonly (infer R)[] ? R : T>;
};

/** One page: the rows, and the cursor for the next page. `next` is `null` on the last page. */
export type Page<Row> = {
  readonly items: readonly Row[];
  readonly next: string | null;
};

/**
 * `page` options. `after` is the `next` of the page before.
 *
 * `page` refuses a window helper when the call runs (OKM1120). The keyset
 * cursor has no window value to encode.
 */
export type PageOptions<S extends QuerySchema, K extends keyof S["~byName"]> = ReadOptions<S, K> & {
  /** Rows in the page. At least 1. */
  readonly limit: number;
  /** The `next` of the previous page, made for the same `orderBy`. */
  readonly after?: string | null;
};

/**
 * Fields `sum` and `avg` take: those typed `number` or `string`.
 *
 * A `numeric` column is a string by default. The types cannot tell it from a
 * `text` column, so `sum` over `text` is refused when the call runs (OKM1124).
 */
type NumericKeys<Row> = {
  readonly [F in keyof Row]-?: [NonNullable<Row[F]>] extends [number | string] ? F : never;
}[keyof Row] &
  string;

/** One `orderBy` value. `asc` is nulls last and `desc` is nulls first unless `nulls` is set. */
type SortDir = "asc" | "desc" | { readonly dir: "asc" | "desc"; readonly nulls?: "first" | "last" };

/** One `select` entry of `aggregate`: a single function and its field. */
export type AggregateCall<Field extends string, Numeric extends string> =
  | { readonly count: true }
  | { readonly countDistinct: Field }
  | { readonly sum: Numeric }
  | { readonly avg: Numeric }
  | { readonly min: Field }
  | { readonly max: Field };

/**
 * `aggregate` options with named aggregates.
 *
 * Each entry is one function and gives one flat result key, so one call can
 * hold several of the same function and column. A name that is a group field,
 * a bucket `as`, or `count`, `countDistinct`, `sum`, `avg`, `min`, or `max` is
 * refused. The `select` overloads of `aggregate` take these, so a call without
 * `select` does not pay for them in type cost.
 */
export type NamedAggregateOptions<S extends QuerySchema, K extends keyof S["~byName"]> = {
  readonly select: {
    readonly [name: string]: AggregateCall<keyof RowOf<S, K> & string, NumericKeys<RowOf<S, K>>>;
  };
  /** Keeps groups by their aggregates. Checked against the names of `select` on the call. */
  readonly having?: object;
};

/**
 * `having`: the same predicate form as `where`, over the aggregate names.
 *
 * `or()` may be the whole filter. An aggregate over a nullable column is
 * `T | null`, so `null` and the comparisons all type as they do in `where`.
 */
export type HavingOf<Row> = FieldWhere<Row> | Or<FieldWhere<Row>>;

/** `having` without `select`: `count` is the only name. */
type CountHaving = HavingOf<{ readonly count: number }>;

/**
 * Types `having` from the names of `select`, on the call.
 *
 * It sits on the `select` overloads, so a call without `select` builds none of it.
 */
type HavingGuard<Row, O> = O extends {
  readonly select: infer M;
  readonly having?: infer H;
}
  ? {
      readonly having?:
        | ClosedWhere<
            H,
            FieldWhere<
              { readonly count: number } & { readonly [N in keyof M]: CallValue<Row, M[N]> }
            >
          >
        | Or<
            FieldWhere<
              { readonly count: number } & { readonly [N in keyof M]: CallValue<Row, M[N]> }
            >
          >;
    }
  : unknown;

/** The type of one named aggregate: a count is a number, the rest follow the field. */
type CallValue<Row, E> = E extends { readonly count: true }
  ? number
  : E extends { readonly countDistinct: string }
    ? number
    : E extends
          | { readonly sum: infer N }
          | { readonly avg: infer N }
          | { readonly min: infer N }
          | { readonly max: infer N }
      ? NonNullable<Row[N & keyof Row]> | null
      : never;

/** `aggregate` options. A hidden field is refused at runtime. */
export type AggregateOptions<S extends QuerySchema, K extends keyof S["~byName"]> = CallOptions & {
  readonly where?: WhereOf<S, K>;
  /** Suppress a warning rule. Absent when every firing rule should report. */
  readonly ignore?: CallIgnore;
  /** One result row per distinct combination. Needs `limit`, or `.all(reason)`. */
  readonly groupBy?: readonly ((keyof RowOf<S, K> & string) | Bucket<string, string, string>)[];
  /** Adds `count`, the number of rows in the group. */
  readonly count?: true;
  /** Adds `countDistinct.<field>`: how many different non-null values the group holds. */
  readonly countDistinct?: readonly (keyof RowOf<S, K> & string)[];
  readonly sum?: readonly NumericKeys<RowOf<S, K>>[];
  readonly avg?: readonly NumericKeys<RowOf<S, K>>[];
  readonly min?: readonly (keyof RowOf<S, K> & string)[];
  readonly max?: readonly (keyof RowOf<S, K> & string)[];
  /**
   * Orders the groups. A `groupBy` field, a bucket `as`, `count`, or a `select` name.
   * `{ dir, nulls }` places NULLs; `asc` puts them last and `desc` first.
   * Without it, groups come in `groupBy` order.
   */
  readonly orderBy?: OrderBy<RowOf<S, K>> | { readonly [key: string]: SortDir | undefined };
  readonly limit?: number;
};

/** `true` when a group entry is a bucket. A mix of fields and buckets is `boolean`. */
type HasBucket<G> = G extends Bucket<string, string, string> ? true : false;

/** One bucket key. A string group contributes nothing. */
type BucketPiece<Row, G> =
  G extends Bucket<infer C, infer U, infer A>
    ? {
        readonly [K in A]:
          | (U extends "second" | "minute" | "hour" ? Temporal.Instant : Temporal.PlainDate)
          | (C extends keyof Row ? (null extends Row[C] ? null : never) : null);
      }
    : {};

/** Intersection of a union of group pieces. */
type Intersect<U> = (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void
  ? I
  : unknown;

/**
 * Group keys on an aggregate row.
 *
 * A plain field list stays `Pick`. A bucket list adds each `as` key. The value
 * is `Temporal.PlainDate` for a calendar unit and `Temporal.Instant` for a
 * clock unit, and includes `null` when the column does.
 */
type GroupOf<Row, G> =
  boolean extends HasBucket<G>
    ? Pick<Row, Extract<G, keyof Row>> & Intersect<BucketPiece<Row, G>>
    : [G] extends [Bucket<string, string, string>]
      ? Intersect<BucketPiece<Row, G>>
      : Pick<Row, G & keyof Row>;

/** A group: its fields, and the aggregates the call named. */
export type AggregateRow<Row, O> = Show<
  (O extends { readonly groupBy: readonly (infer G)[] } ? GroupOf<Row, G> : unknown) &
    (O extends { readonly count: true } ? { readonly count: number } : unknown) &
    (O extends { readonly countDistinct: readonly (infer F)[] }
      ? { readonly countDistinct: { readonly [P in F & keyof Row]: number } }
      : unknown) &
    (O extends { readonly sum: readonly (infer F)[] }
      ? { readonly sum: { readonly [P in F & keyof Row]: NonNullable<Row[P]> | null } }
      : unknown) &
    (O extends { readonly avg: readonly (infer F)[] }
      ? { readonly avg: { readonly [P in F & keyof Row]: NonNullable<Row[P]> | null } }
      : unknown) &
    (O extends { readonly min: readonly (infer F)[] }
      ? { readonly min: { readonly [P in F & keyof Row]: NonNullable<Row[P]> | null } }
      : unknown) &
    (O extends { readonly max: readonly (infer F)[] }
      ? { readonly max: { readonly [P in F & keyof Row]: NonNullable<Row[P]> | null } }
      : unknown) &
    (O extends { readonly select: infer M }
      ? { readonly [N in keyof M]: CallValue<Row, M[N]> }
      : unknown)
>;

/** What {@link Read.inspect} returns. */
export type Inspection = {
  readonly intent: {
    readonly op: ReadOp;
    readonly table: string;
    readonly where: unknown;
    readonly select: unknown;
    readonly orderBy: unknown;
    readonly limit: unknown;
    readonly include: unknown;
    readonly all: string | undefined;
  };
  readonly rules: readonly AppliedRule[];
  readonly plan: {
    readonly strategy: "postgres:single-statement";
    readonly statements: 1;
    readonly fingerprint: string;
  };
  readonly sql: { readonly text: string; readonly params: readonly (string | null)[] };
  readonly routing: RoutingDecision;
};

/** Why the router chose an endpoint. */
export type RoutingDecision = {
  readonly endpoint: string;
  readonly role: "primary" | "replica";
  readonly reason: string;
};

/** One pool the router can return. */
export type Endpoint = {
  readonly name: string;
  readonly role: "primary" | "replica";
  readonly pool: {
    readonly capabilities: { readonly stream: boolean };
    execute(
      text: string,
      params?: readonly (string | null)[],
      options?: { readonly signal?: AbortSignal; readonly timeout?: number },
    ): Promise<{ readonly rows: readonly (readonly (string | null)[])[] }>;
    stream?(
      text: string,
      params?: readonly (string | null)[],
    ): AsyncIterable<readonly (readonly (string | null)[])[]>;
    close(): Promise<void>;
  };
};

/** A target's endpoints. The primary is not a replica. */
export type Topology = {
  readonly primary: Endpoint;
  readonly replicas: readonly Endpoint[];
};

/** A named target. P15 has one. */
export type Target = {
  readonly name: string;
  readonly topology: Topology;
};

/** Picks an endpoint. One operation uses one endpoint. */
export type Router = {
  route(input: {
    readonly operation: "read" | "write";
    readonly constraint: "auto" | "primary" | "replica";
  }): RoutingDecision;
};

export type { OptionalInsert, RequiredInsert };

/** Insert shape of one table. */
export type InsertOf<
  S extends QuerySchema,
  K extends keyof S["~byName"],
> = S["~byName"][K] extends {
  readonly "~insert": infer I;
}
  ? I
  : never;

/** Update shape of one table. */
export type UpdateOf<
  S extends QuerySchema,
  K extends keyof S["~byName"],
> = S["~byName"][K] extends {
  readonly "~update": infer U;
}
  ? U
  : never;

/**
 * `set` values.
 *
 * `undefined` leaves the field unchanged. `null` sets null, and only on a
 * nullable column. `inc` adds to a number or bigint column. A null number
 * stays null. `json.set` and `arr` write json and arrays.
 */
export type UpdateSet<S extends QuerySchema, K extends keyof S["~byName"]> = {
  readonly [F in keyof UpdateOf<S, K>]?:
    | UpdateOf<S, K>[F]
    | IncOf<UpdateOf<S, K>[F]>
    | WriteOp<NonNullable<UpdateOf<S, K>[F]>>;
};

/** Conflict handling on `insert` (spec §11). */
export type OnConflict<S extends QuerySchema, K extends keyof S["~byName"]> =
  | "error"
  | "ignore"
  | {
      readonly on: string | readonly string[];
      readonly update: readonly (keyof UpdateOf<S, K> & string)[];
    }
  | { readonly on: string | readonly string[]; readonly return: true };

/** Options for `insert`. */
export type InsertOptions<S extends QuerySchema, K extends keyof S["~byName"]> = {
  readonly onConflict?: OnConflict<S, K>;
  readonly returning?: readonly (keyof RowOf<S, K> & string)[];
  /** Guarded fields this call may set. */
  readonly allow?: readonly (keyof RowOf<S, K> & string)[];
  readonly expect?: number;
  readonly signal?: AbortSignal;
  readonly timeout?: number;
  /** `false` skips validation for this call. Codecs still run. */
  readonly validate?: boolean;
};

/** Options for `update` and `delete`. */
export type WriteOptions<S extends QuerySchema, K extends keyof S["~byName"]> = {
  readonly returning?: true | readonly (keyof RowOf<S, K> & string)[];
  /** Guarded fields this call may set. `delete` ignores it. */
  readonly allow?: readonly (keyof RowOf<S, K> & string)[];
  readonly expect?: number;
  readonly signal?: AbortSignal;
  readonly timeout?: number;
  /** `false` skips validation for this call. `delete` ignores it. */
  readonly validate?: boolean;
};

/** `{ count }` from an update or delete without `returning`. */
export type WriteCount = { readonly count: number };

/** Who asked for a column reported by {@link Write.describe}. */
export type WriteColumnLabel = "caller" | "observer";

/** One column {@link Write.describe} reports. */
export type WriteColumn = {
  readonly name: string;
  readonly label: WriteColumnLabel;
};

/** What {@link Write.describe} returns. */
export type WriteDescription = {
  readonly statements: readonly {
    readonly text: string;
    readonly columns: readonly WriteColumn[];
  }[];
};

/** What {@link Write.inspect} returns. The SQL includes observer `RETURNING`. */
export type WriteInspection = {
  readonly statements: readonly {
    readonly text: string;
    readonly params?: readonly (string | null)[];
  }[];
  readonly rules: readonly AppliedRule[];
};

/** A write handle. Await it, or read its SQL before it runs. */
export type Write<T> = Promise<T> & {
  /** Statement text and parameters, one entry per chunk. */
  sql(): Promise<{
    readonly statements: readonly {
      readonly text: string;
      readonly params?: readonly (string | null)[];
    }[];
  }>;
  /** Statements and the rules that shaped them, including observer `RETURNING`. */
  inspect(): Promise<WriteInspection>;
  /** Returned columns. Observer primary-key columns are labeled `"observer"`. */
  describe(): Promise<WriteDescription>;
  /** `{ ok, value }` or `{ ok, error }`. */
  safe(): Promise<SafeResult<T>>;
  /** Throws `not_found` when the changed-row count is not `count`. */
  expect(count: number): Write<T>;
  /** Allows `update` or `delete` without `where`. */
  all(reason: string): Write<T>;
};

/** `set` plus guarded fields named in `{ allow }`. */
type AllowedSet<
  S extends QuerySchema,
  K extends keyof S["~byName"],
  Allow extends readonly (keyof RowOf<S, K> & string)[],
> = UpdateSet<S, K> & Partial<Pick<RowOf<S, K>, Allow[number]>>;

/** One update, or a per-row list, when `{ allow }` opens guarded fields. */
type AllowedUpdate<
  S extends QuerySchema,
  K extends keyof S["~byName"],
  Allow extends readonly (keyof RowOf<S, K> & string)[],
> =
  | {
      readonly where?: WhereOf<S, K>;
      readonly set: AllowedSet<S, K, Allow>;
      readonly version?: number;
    }
  | readonly {
      readonly id?: unknown;
      readonly where?: WhereOf<S, K>;
      readonly set: AllowedSet<S, K, Allow>;
      readonly version?: number;
    }[];

/** Allowed update with `version` required (versioned tables, D305). */
type AllowedUpdateVersioned<
  S extends QuerySchema,
  K extends keyof S["~byName"],
  Allow extends readonly (keyof RowOf<S, K> & string)[],
> =
  | {
      readonly where?: WhereOf<S, K>;
      readonly set: AllowedSet<S, K, Allow>;
      readonly version: number;
    }
  | readonly {
      readonly id?: unknown;
      readonly where?: WhereOf<S, K>;
      readonly set: AllowedSet<S, K, Allow>;
      readonly version: number;
    }[];

/**
 * One update, or a per-row list in one statement.
 *
 * `lock: "skip"` with `limit` claims that many matching rows and leaves rows
 * another transaction already holds. It is not valid on a list.
 *
 * `version` is optional on this alias. {@link TableApi.update} picks the
 * required-version form when the table is `versioned()` (D305).
 * `version: "any"` is accepted only with `lock: "skip"` and `limit`.
 */
export type UpdateTarget<S extends QuerySchema, K extends keyof S["~byName"]> =
  | {
      readonly where?: WhereOf<S, K>;
      readonly set: UpdateSet<S, K>;
      readonly limit?: number;
      readonly lock?: "skip";
      /** Version read from the row. Required when the table is `versioned()`. */
      readonly version?: number;
    }
  | readonly {
      readonly id?: unknown;
      readonly where?: WhereOf<S, K>;
      readonly set: UpdateSet<S, K>;
      /** Version read from the row. Required when the table is `versioned()`. */
      readonly version?: number;
    }[];

/**
 * `version: "any"` claim.
 *
 * `lock: "skip"` and `limit` are required. The call returns the claimed rows.
 * A miss is an empty array (O-5). Kept off {@link UpdateTargetVersioned} so
 * `Omit` on that union cannot treat `lock` and `limit` as optional.
 *
 * `where` is closed the same way as an integer update, so an unknown field
 * is refused. A hidden filterable column stays. A later `update` overload
 * accepts the claim. An earlier overload is built for every update and
 * pushes the query-200-validate type ceiling over.
 */
type VersionAnyArg<
  S extends QuerySchema,
  K extends keyof S["~byName"],
  W,
> = S["~byName"][K] extends {
  readonly "~versioned": true;
}
  ? {
      readonly where?: FilterWhereOf<S, K, W>;
      readonly set: UpdateSet<S, K>;
      readonly limit: number;
      readonly lock: "skip";
      readonly version: "any";
    }
  : never;

/** Update target with `version` required (versioned tables, D305). */
type UpdateTargetVersioned<S extends QuerySchema, K extends keyof S["~byName"]> =
  | {
      readonly where?: WhereOf<S, K>;
      readonly set: UpdateSet<S, K>;
      readonly limit?: number;
      readonly lock?: "skip";
      /** Version read from the row. */
      readonly version: number;
    }
  | readonly {
      readonly id?: unknown;
      readonly where?: WhereOf<S, K>;
      readonly set: UpdateSet<S, K>;
      /** Version read from the row. */
      readonly version: number;
    }[];

/** `update` target: required `version` on versioned tables, else {@link UpdateTarget}. */
type UpdateArg<S extends QuerySchema, K extends keyof S["~byName"]> = S["~byName"][K] extends {
  readonly "~versioned": true;
}
  ? UpdateTargetVersioned<S, K>
  : UpdateTarget<S, K>;

/** `{ allow }` update target: required `version` on versioned tables. */
type AllowedUpdateArg<
  S extends QuerySchema,
  K extends keyof S["~byName"],
  Allow extends readonly (keyof RowOf<S, K> & string)[],
> = S["~byName"][K] extends { readonly "~versioned": true }
  ? AllowedUpdateVersioned<S, K, Allow>
  : AllowedUpdate<S, K, Allow>;

/** `{ count, archiveId }` from one `archive()` call. */
export type ArchiveCount = {
  readonly count: number;
  readonly archiveId: string;
};

/** `archive`, `restore`, and the visibility modifiers. Present only on archivable tables. */
type ArchiveOps<S extends QuerySchema, K extends keyof S["~byName"] & string, L> = {
  /**
   * Archives the active rows that match.
   *
   * One new `archiveId` is shared by the row and its cascaded children.
   * `expect` matches {@link TableApi.update}.
   */
  archive(
    target: { readonly where?: WhereOf<S, K> },
    options?: WriteOptions<S, K>,
  ): Write<ArchiveCount>;
  /**
   * Restores archived rows.
   *
   * `where` restores those rows and the children that carry their `archiveId`.
   * `archiveId` restores that whole operation. An archived parent fails.
   */
  restore(
    target: { readonly where?: WhereOf<S, K> } | { readonly archiveId: string },
    options?: WriteOptions<S, K>,
  ): Write<WriteCount>;
  /** Reads, updates, and deletes include archived rows. */
  withArchived(): TableApi<S, K, L>;
  /** Reads, updates, and deletes target only archived rows. */
  onlyArchived(): TableApi<S, K, L>;
};

/**
 * What a call that states no limit returns: the read when `connect({ limits })`
 * set `Key`, and otherwise a handle that only offers `.all(reason)`.
 */
type Unbounded<S, Key extends keyof Limits, R> =
  Defaults<S, Key> extends true ? R : { all(reason: string): R };

/** `page` options with no `limit`, for a client with `limits.page`. Otherwise `never`. */
type DefaultPage<
  S extends QuerySchema,
  K extends keyof S["~byName"],
  Filter extends boolean = false,
> =
  Defaults<S, "page"> extends true
    ? Filter extends true
      ? Omit<PageOptions<S, K>, "where" | "orderBy" | "limit"> &
          ReadFilterOptions<S, K> & { readonly limit?: number }
      : Omit<PageOptions<S, K>, "limit"> & { readonly limit?: number }
    : never;

/**
 * Methods an opt-in feature adds to a table handle.
 *
 * The interface is empty here, so an application that imports no feature
 * pays one empty instantiation per table. A feature's entry point merges its
 * members in with a module augmentation, and its types appear only when that
 * entry point is part of the program.
 *
 * @typeParam S - Connected schema
 * @typeParam K - Table name
 */
// oxlint-disable-next-line typescript/no-empty-object-type, no-unused-vars
export interface TableExtras<S extends QuerySchema, K extends keyof S["~byName"] & string> {}

/** Methods on one table. */
export type TableApi<S extends QuerySchema, K extends keyof S["~byName"] & string, L = unknown> = {
  find<const O extends FindOptions<S, K> & L & { readonly limit: number }>(
    options: O,
  ): Read<readonly ResultRow<S, K, O>[]>;
  find<const O extends FindFilterOptions<S, K, L> & { readonly limit: number }>(
    options: O,
  ): Read<readonly ResultRow<S, K, O>[]>;
  find<const O extends FindFilterOptions<S, K, L>>(
    options: O,
  ): Unbounded<S, "find", Read<readonly ResultRow<S, K, O>[]>>;
  find<const O extends FindOptions<S, K> & L>(
    options: O,
  ): Unbounded<S, "find", Read<readonly ResultRow<S, K, O>[]>>;
  one<const O extends ReadOptions<S, K>>(options?: O): Read<ResultRow<S, K, O> | null>;
  one<const O extends ReadFilterOptions<S, K>>(options?: O): Read<ResultRow<S, K, O> | null>;
  /**
   * One page of rows and the cursor for the next.
   *
   * Keyset on `orderBy` plus the primary key, so a page is stable while rows
   * are inserted. Pass `next` back as `after` with the same `orderBy`.
   */
  page<const O extends PageOptions<S, K>>(options: O): Query<Page<ResultRow<S, K, O>>>;
  page<const O extends Omit<PageOptions<S, K>, "where" | "orderBy"> & ReadFilterOptions<S, K>>(
    options: O,
  ): Query<Page<ResultRow<S, K, O>>>;
  page<const O extends DefaultPage<S, K>>(options: O): Query<Page<ResultRow<S, K, O>>>;
  page<const O extends DefaultPage<S, K, true>>(options: O): Query<Page<ResultRow<S, K, O>>>;
  /**
   * Counts, sums, averages, and finds extremes, per group.
   *
   * The tenant and active-set rules apply as in `find`.
   */
  aggregate<
    const O extends AggregateOptions<S, K> &
      (
        | { readonly limit: number; readonly select?: undefined; readonly having?: CountHaving }
        | {
            readonly groupBy?: undefined;
            readonly select?: undefined;
            readonly having?: undefined;
          }
      ),
  >(
    options: O,
  ): Query<readonly AggregateRow<RowOf<S, K>, O>[]>;
  aggregate<
    const O extends AggregateOptions<S, K> & {
      readonly select?: undefined;
      readonly having?: CountHaving;
    },
  >(
    options: O,
  ): Unbounded<S, "groupBy", Query<readonly AggregateRow<RowOf<S, K>, O>[]>>;
  aggregate<
    const O extends AggregateOptions<S, K> &
      NamedAggregateOptions<S, K> &
      ({ readonly limit: number } | { readonly groupBy?: undefined; readonly having?: undefined }),
  >(
    options: O & HavingGuard<RowOf<S, K>, O>,
  ): Query<readonly AggregateRow<RowOf<S, K>, O>[]>;
  aggregate<const O extends AggregateOptions<S, K> & NamedAggregateOptions<S, K>>(
    options: O & HavingGuard<RowOf<S, K>, O>,
  ): Unbounded<S, "groupBy", Query<readonly AggregateRow<RowOf<S, K>, O>[]>>;
  count(
    options?: CallOptions & {
      readonly where?: WhereOf<S, K>;
      readonly search?: TextSearch<RowOf<S, K>>;
    },
  ): Read<number>;
  count<const O extends CountFilterOptions<S, K>>(options?: O): Read<number>;
  exists(options?: CallOptions & { readonly where?: WhereOf<S, K> }): Read<boolean>;
  /**
   * Inserts one row. Unknown keys are dropped. `{ allow }` may set guarded fields.
   *
   * Optional columns are optional keys, so completion lists the ones not yet written.
   */
  insert<const Allow extends readonly (keyof RowOf<S, K> & string)[]>(
    data: RequiredInsert<InsertOf<S, K>> &
      OptionalInsert<InsertOf<S, K>> &
      Partial<Pick<RowOf<S, K>, Allow[number]>>,
    options: InsertOptions<S, K> & { readonly allow: Allow },
  ): Write<Show<RowOf<S, K>>>;
  insert(
    data: RequiredInsert<InsertOf<S, K>> & OptionalInsert<InsertOf<S, K>>,
    options?: InsertOptions<S, K>,
  ): Write<Show<RowOf<S, K>>>;
  /**
   * Inserts a list in one transaction. Unknown keys are dropped.
   *
   * `{ allow: ["id"] }` may set `id` on a client-generator primary key.
   * A row that omits `id` still takes the generator. A longer `allow` list
   * does not open `id` in this type.
   *
   * @param data - Rows. `id` is optional when `allow` is exactly `["id"]`
   * @param options - Must set `allow` to `["id"]`
   * @returns The inserted rows
   */
  insert(
    data: readonly (RequiredInsert<InsertOf<S, K>> &
      OptionalInsert<InsertOf<S, K>> &
      Partial<Pick<RowOf<S, K>, "id" & keyof RowOf<S, K>>>)[],
    options: InsertOptions<S, K> & { readonly allow: readonly ["id"] },
  ): Write<readonly Show<RowOf<S, K>>[]>;
  /**
   * Inserts a list in one transaction. Unknown keys are dropped.
   *
   * Rows may carry different keys. An omitted key or an explicit `undefined` takes the
   * database default for that row; `null` stays NULL.
   */
  insert(
    data: readonly (RequiredInsert<InsertOf<S, K>> & OptionalInsert<InsertOf<S, K>>)[],
    options?: InsertOptions<S, K>,
  ): Write<readonly Show<RowOf<S, K>>[]>;
  /**
   * Updates matching rows, or a per-row list in one statement. `where` is required.
   *
   * `{ allow, returning: true }` returns the written rows. `{ allow }` without
   * `returning: true` returns `{ count }`. On a `versioned()` table, `version`
   * is required (D305), except `version: "any"` with `lock: "skip"` and `limit`,
   * which returns the claimed rows. A miss is an empty array.
   */
  update<
    const Allow extends readonly (keyof RowOf<S, K> & string)[],
    const Opt extends WriteOptions<S, K> & { readonly allow: Allow },
  >(
    target: AllowedUpdateArg<S, K, Allow>,
    options: Opt,
  ): [Opt["returning"]] extends [true] ? Write<readonly Show<RowOf<S, K>>[]> : Write<WriteCount>;
  update(
    target: UpdateArg<S, K>,
    options: WriteOptions<S, K> & { readonly returning: true },
  ): Write<readonly Show<RowOf<S, K>>[]>;
  update(target: UpdateArg<S, K>, options?: WriteOptions<S, K>): Write<WriteCount>;
  update<const T extends ExactConstraint<T, UpdateFilterTarget<S, K, T["where"]>>>(
    target: T,
    options: WriteOptions<S, K> & { readonly returning: true },
  ): Write<readonly Show<RowOf<S, K>>[]>;
  update<
    const T extends ExactConstraint<
      T,
      UpdateFilterTarget<S, K, T["where"]> | VersionAnyArg<S, K, T["where"]>
    >,
  >(
    target: T,
    options?: WriteOptions<S, K>,
  ): [T] extends [{ readonly version: "any" }]
    ? Write<readonly Show<RowOf<S, K>>[]>
    : Write<WriteCount>;
  /**
   * Last signature, so `Parameters` reads {@link UpdateArg}.
   *
   * A generic exact constraint collapses to `Record<string, never>` there and
   * a helper then rejects a valid update. This signature repeats the integer
   * form. A call still matches an earlier overload, including `version: "any"`.
   */
  update(target: UpdateArg<S, K>, options?: WriteOptions<S, K>): Write<WriteCount>;
  /**
   * Deletes matching rows. `where` is required.
   *
   * `{ returning: true }` is not accepted. Pass the field names, or omit
   * `returning` for `{ count }`.
   */
  delete(
    target: { readonly where?: WhereOf<S, K> },
    options?: Omit<WriteOptions<S, K>, "returning"> & {
      readonly returning?: Exclude<WriteOptions<S, K>["returning"], true>;
    },
  ): Write<WriteCount>;
  delete<const T extends ExactConstraint<T, DeleteFilterTarget<S, K, T["where"]>>>(
    target: T,
    options?: Omit<WriteOptions<S, K>, "returning"> & {
      readonly returning?: Exclude<WriteOptions<S, K>["returning"], true>;
    },
  ): Write<WriteCount>;
  /**
   * Rows below `id`, walking the table's self-relation.
   *
   * One statement. A row already seen is not entered again, so a cycle in the
   * data returns. A missing id returns no rows. `where` and a preset filter
   * the rows that come back. Tenancy and the active set apply at every step.
   */
  descendants<const O extends TreeOptions<S, K>>(
    id: unknown,
    options?: O,
  ): Query<readonly ResultRow<S, K, O>[]>;
  /** Rows above `id`. The options match {@link TableApi.descendants}. */
  ancestors<const O extends TreeOptions<S, K>>(
    id: unknown,
    options?: O,
  ): Query<readonly ResultRow<S, K, O>[]>;
  /**
   * Sets a to-many relation to exactly `ids`.
   *
   * One statement. A join table gains and loses link rows. A nullable foreign
   * key is set or cleared, and the related row stays. A link that would have
   * to delete a row is refused. Duplicate ids count once. An id that is not
   * in the related table is `not_found`, and nothing is written.
   */
  sync(id: unknown, relation: string, ids: readonly unknown[], options?: SyncOptions): SyncHandle;
} & (S["~byName"][K] extends { readonly "~archive": true } ? ArchiveOps<S, K, L> : unknown) &
  PresetApi<S, K, L> &
  TableExtras<S, K>;

/**
 * One method per preset the table or its traits declare.
 *
 * Each takes the preset's own arguments and returns the table handle with the
 * preset applied, so calls chain: `tasks.pending().ownedBy(userId).find({})`.
 * A table without presets adds nothing.
 */
type PresetApi<
  S extends QuerySchema,
  K extends keyof S["~byName"] & string,
  L,
> = S["~byName"][K] extends { readonly "~presets": infer P }
  ? {
      readonly [N in keyof P & string]: P[N] extends (...all: infer All) => unknown
        ? All extends readonly [unknown, ...infer A]
          ? (...args: A) => TableApi<S, K, L>
          : never
        : never;
    }
  : unknown;

/**
 * `[Symbol.asyncDispose]` when `Symbol` defines it.
 *
 * The check stays in the built declaration. A consumer `lib` without
 * `asyncDispose` does not see the method, including with `skipLibCheck` off.
 */
type IfAsyncDisposable<S> = S extends { readonly asyncDispose: infer D }
  ? D extends symbol
    ? { [K in D]: () => Promise<void> }
    : object
  : object;

/** Tenant key, when the schema set column tenancy. */
type TenantKeyOf<S> = S extends { readonly tenancy: { readonly key: infer K extends string } }
  ? K
  : never;

/** Tables that stay off the root client because they carry the tenant key. */
type ScopedName<S extends QuerySchema> =
  TenantKeyOf<S> extends never
    ? never
    : {
        readonly [K in keyof S["~byName"] & string]: S["~byName"][K] extends {
          readonly "~global": string;
        }
          ? never
          : K;
      }[keyof S["~byName"] & string];

/** Tables on the root client. Global tables stay. Tenant tables need `for()`. */
type RootName<S extends QuerySchema> = Exclude<keyof S["~byName"] & string, ScopedName<S>>;

/** Options of `tx()` (spec §15). */
export type TxOptions = {
  /** Isolation level. The database default when omitted. Only the outermost `tx()` takes it. */
  readonly isolation?: "read committed" | "repeatable read" | "serializable";
  /**
   * How many times to run the callback again after a serialization failure or a
   * deadlock. Each run is a fresh transaction. Other errors, `cancelled` and
   * `outcome_unknown` are never retried. Only the outermost `tx()` takes it.
   */
  readonly retry?: number;
  /** Milliseconds for the whole transaction, retries included. The call fails as `timeout`. */
  readonly timeout?: number;
  /** Aborts the transaction and rolls it back. The call fails as `cancelled`. */
  readonly signal?: AbortSignal;
};

/** What the callback of a batch gets back: one result per operation, in order. */
type BatchResults<Ops extends readonly unknown[]> = {
  -readonly [I in keyof Ops]: Awaited<Ops[I]>;
};

/**
 * Tables of a client: the root client leaves tenant tables out. A flag, not a name list,
 * because a name list as a type argument costs one instantiation per table on every
 * use of the client (D176).
 */
type TxNames<S extends QuerySchema, Root extends boolean> = Root extends true
  ? RootName<S>
  : keyof S["~byName"] & string;

/**
 * `tx` and `batch`, on the root client, a scoped client, and the client a transaction hands out.
 *
 * @typeParam S - Connected schema
 * @typeParam Root - True on the root client, whose tenant tables need `for()` first
 */
type TxApi<S extends QuerySchema, Root extends boolean> = {
  /**
   * Runs `fn` in a transaction on one reserved connection of the primary.
   *
   * The callback gets a client with the same tables, presets, tenancy and archive
   * handling. It commits when `fn` resolves and rolls back when it throws. Inside a
   * transaction this is a savepoint on the same connection.
   */
  tx<T>(fn: (t: TxClient<S, Root>) => Promise<T>): Promise<T>;
  tx<T>(options: TxOptions, fn: (t: TxClient<S, Root>) => Promise<T>): Promise<T>;
  /**
   * Runs writes as one atomic unit on the primary. Results come back in order.
   *
   * A failure rolls everything back and the error carries `batchIndex`. Inside a
   * transaction it runs on a savepoint, so the transaction survives a failure.
   */
  batch<const Ops extends readonly Write<unknown>[]>(
    ops: Ops,
    options?: CallOptions,
  ): Promise<BatchResults<Ops>>;
};

/**
 * The client the callback of `tx()` gets.
 *
 * Its tables take row locks on `find`. It has no `close` and no `for()`: scope the
 * client before calling `tx()`.
 *
 * @typeParam S - Connected schema
 * @typeParam Root - True on the root client, whose tenant tables need `for()` first
 */
export type TxClient<S extends QuerySchema, Root extends boolean = false> = {
  readonly [K in TxNames<S, Root>]: TableApi<S, K, LockOptions>;
} & {
  /** Looks up a table by name. An unknown name is OKM1120. */
  table<K extends TxNames<S, Root>>(name: K): TableApi<S, K, LockOptions>;
  /**
   * Runs `fn` after the outermost transaction commits.
   *
   * It never runs on rollback. Callbacks run in order. An error in one is reported to
   * `hookm.onError` and never changes the commit result.
   */
  afterCommit(fn: () => void | Promise<void>): void;
  /**
   * Takes a transaction-level advisory lock. It is released at commit or rollback.
   *
   * A string is hashed; a number or bigint is the key itself.
   */
  advisoryLock(key: string | number | bigint, options?: CallOptions): Promise<void>;
} & TxApi<S, Root>;

/** A view field: its column name in camel case, as the client publishes it. */
type CamelName<N extends string> = N extends `_${infer Rest}`
  ? CamelName<Rest>
  : N extends `${infer Head}_${infer Tail}`
    ? `${Head}${Capitalize<CamelName<Tail>>}`
    : N;

/** One view row. Every column is decoded as text, so each field is a string or null. */
type ViewRow<D> = D extends {
  readonly "~columns"?: infer C extends readonly { readonly name: string }[];
}
  ? { readonly [Col in C[number] as CamelName<Col["name"]>]: string | null }
  : never;

/** Options `find` and `one` take on a view. */
type ViewReadOptions<Row> = CallOptions & {
  readonly where?: FieldWhere<Row>;
  readonly select?: readonly (keyof Row & string)[];
  readonly orderBy?: OrderBy<Row>;
  readonly limit?: number;
};

/** The read-only handle `db.views` holds for one view. */
type ViewApi<Row> = {
  find<const O extends ViewReadOptions<Row> & { readonly limit: number }>(
    options: O,
  ): Read<
    readonly Show<Selected<Row, O extends { readonly select: infer Sel } ? Sel : undefined>>[]
  >;
  find<const O extends ViewReadOptions<Row>>(
    options: O,
  ): {
    all(
      reason: string,
    ): Read<
      readonly Show<Selected<Row, O extends { readonly select: infer Sel } ? Sel : undefined>>[]
    >;
  };
  one<const O extends ViewReadOptions<Row>>(
    options?: O,
  ): Read<Show<Selected<Row, O extends { readonly select: infer Sel } ? Sel : undefined>> | null>;
  count(options?: CallOptions & { readonly where?: FieldWhere<Row> }): Read<number>;
  exists(options?: CallOptions & { readonly where?: FieldWhere<Row> }): Read<boolean>;
};

/**
 * `refresh()` on a materialized view.
 *
 * No arguments. It runs `REFRESH MATERIALIZED VIEW`, with `CONCURRENTLY` when
 * the view declares `refresh: "concurrently"`. It is a write, so it uses the
 * primary. It is not tenant-scoped: a scoped client still refreshes the whole view.
 */
type MaterializedViewApi<Row> = ViewApi<Row> & {
  refresh(): Promise<void>;
};

/** `db.views`, typed from `schema({ views })`. Absent when the schema declares none. */
type ViewsClient<S> = S extends { readonly "~views": infer V extends readonly unknown[] }
  ? {
      readonly views: {
        readonly [
          D in V[number] as D extends { readonly name: infer N extends string }
            ? CamelName<N>
            : never
        ]: D extends { readonly "~kind": "materialized" }
          ? MaterializedViewApi<Show<ViewRow<D>>>
          : ViewApi<Show<ViewRow<D>>>;
      };
    }
  : unknown;

/**
 * `with()` on a client opened with `connect({ session })`.
 *
 * Absent when the connection declared no session settings.
 *
 * @typeParam C - The `sessionSettings()` value, or `undefined`
 * @typeParam S - Connected schema
 * @typeParam Root - True on the root client. `with()` returns the same kind of client
 */
type SettingsOf<C> = C extends SessionContext<infer M> ? M : SettingMap;

type SessionMethods<C, S extends QuerySchema, Root extends boolean> = {
  /**
   * Opens a client that sets these values before each unit of work.
   *
   * One `set_config(..., true)` statement is the first statement of the
   * transaction. Every required key is required here. Later calls add to
   * the earlier ones. It composes with `for()` and `unscoped()` in any order.
   *
   * @param values - Setting key to value
   */
  with(
    values: SessionValues<SettingsOf<C>>,
  ): Root extends true ? Connected<S, C> : ScopedClient<S, C>;
};

/** A client whose tables are already inside one tenant or an unscoped reason. */
type ScopedClient<S extends QuerySchema, C = undefined> = {
  readonly [K in keyof S["~byName"] & string]: TableApi<S, K>;
} & {
  /** Looks up a table by name. An unknown name is OKM1120. */
  table<K extends keyof S["~byName"] & string>(name: K): TableApi<S, K>;
  /** Closes the pool when this client opened it. */
  close(): Promise<void>;
  /** Resolves when the dialect and `requires` checks have finished. */
  readonly connected: Promise<void>;
  /** The adapter's frozen capability flags. */
  readonly capabilities: DriverCapabilities;
} & TxApi<S, false> &
  ViewsClient<S> &
  (C extends undefined ? unknown : SessionMethods<C, S, false>) &
  IfAsyncDisposable<typeof Symbol>;

/** `for` and `unscoped` on a schema that set tenancy. */
type ScopeMethods<S extends QuerySchema, C> =
  TenantKeyOf<S> extends never
    ? object
    : {
        /**
         * Opens a client bound to one tenant.
         *
         * The value is the scope. Insert fills it. Reads and writes filter on it.
         * Input cannot set it.
         *
         * @param input - The tenant key and its value
         */
        for(input: { readonly [K in TenantKeyOf<S>]: string }): ScopedClient<S, C>;
        /**
         * Opens a client with no tenant predicate.
         *
         * The reason is stored and shown by `inspect()`. Insert still needs `for()`.
         *
         * @param reason - Why this client leaves the tenant scope
         */
        unscoped(reason: string): ScopedClient<S, C>;
      };

/**
 * A client typed by its own schema.
 *
 * @typeParam S - Connected schema
 * @typeParam C - The `connect({ session })` value, which adds `with()`
 */
export type Connected<S extends QuerySchema, C = undefined> = {
  readonly [K in RootName<S>]: TableApi<S, K>;
} & {
  /** Looks up a table by name. A tenant table on the root client is OKM1701. */
  table<K extends RootName<S>>(name: K): TableApi<S, K>;
  /**
   * Closes the pool when this client opened it.
   *
   * A second call waits on the same close. A client that adopted a pool
   * resolves without closing it.
   */
  close(): Promise<void>;
  /** Resolves when the dialect and `requires` checks have finished. */
  readonly connected: Promise<void>;
  /** The adapter's frozen capability flags. */
  readonly capabilities: DriverCapabilities;
} & TxApi<S, true> &
  ScopeMethods<S, C> &
  ViewsClient<S> &
  (C extends undefined ? unknown : SessionMethods<C, S, true>) &
  IfAsyncDisposable<typeof Symbol>;

/**
 * A catalog `okm build` wrote.
 *
 * `connect` trusts it through `loadTrustedCatalog` when the database hash differs.
 */
export type CatalogArtifact = {
  readonly text: string;
  readonly hash: string;
};

/** `connect` options shared by the Postgres drivers. */
export type ConnectOptions<S extends QuerySchema, C = undefined, D extends Limits = Limits> = {
  readonly schema: S;
  /**
   * Transaction-local session settings from `okmodel/session`.
   *
   * Adds `db.with()`. Postgres only.
   */
  readonly session?: C;
  /**
   * Build artifact. When set, its hash is the code's catalog hash.
   * The JSON is checked only when the database hash differs.
   */
  readonly catalog?: CatalogArtifact;
  /**
   * Directory of `catalog.hash` and `catalog.json`.
   *
   * When omitted, `connect` reads `.okm` under the process cwd if that hash file exists.
   * The hash file is the fast path. A mismatch then reads `catalog.json` once
   * per process and does not rebuild the catalog from the schema.
   */
  readonly catalogDir?: string;
  readonly logger?: {
    error?(entry: { readonly code: string; readonly summary: string }): void;
  };
  readonly errors?: {
    /**
     * Statuses for {@link OkmError.toHttp}.
     *
     * `toHttp()` uses these when the caller does not pass statuses.
     * `toHttp(statuses)` replaces them for that call.
     */
    readonly http?: import("../contracts/error.js").ErrorStatuses;
    /**
     * When `true`, a mapped error keeps bound parameters on `cause` and
     * stores row values for `values()`. Off unless set. A `.sensitive()`
     * column stays redacted either way.
     */
    readonly includeValues?: boolean;
  };
  /**
   * Fail `connect` when `okm_meta` has no catalog hash (OKM1520).
   *
   * Omitted, a database with no recorded hash skips the drift check so an
   * existing database can adopt OKModel. Set this on a production connection.
   * The target name and `NODE_ENV` do not turn it on.
   */
  readonly requireMeta?: boolean;
  /**
   * Replaces a built-in client generator by name.
   *
   * `uuidv4`, `uuidv7`, and `okid` are the names. A custom function passed to
   * `.default()` is not replaced. Tests use this for deterministic ids.
   */
  readonly generators?: import("../contracts/generator.js").IdGenerators;
  readonly signal?: AbortSignal;
  readonly timeout?: number;
  /** Ceilings in milliseconds. See {@link Timeouts}. */
  readonly timeouts?: Timeouts;
  /** Observers of notices, transactions and errors. They cannot change a query (spec §18). */
  readonly hookm?: readonly Hookm[];
  /** Low-level write observer (`okm.observe/1`). See `docs/observer-events.md`. */
  readonly onWrite?: import("./observe-types.js").OnWrite;
  /**
   * Plan-time warning slot from `okmodel/warnings`.
   *
   * Absent, a read does not report OKM2xxx advice.
   */
  readonly warnings?: (
    schema: QuerySchema,
    call: ReadCall,
    stack?: string,
    done?: ReadDone,
  ) => void;
  /** Per-statement observer (`okm.observe/1`). See `docs/observer-events.md`. */
  readonly onQuery?: import("./observe-types.js").OnQuery;
  /**
   * Default limits for reads that state neither `limit` nor `.all(reason)`.
   *
   * Absent, nothing changes. See {@link Limits}.
   */
  readonly limits?: D;
};

/** The `limits` of a client that set none. */
export type NoLimits = Record<never, never>;

/**
 * The schema type of a client whose `connect({ limits })` names keys. A client
 * with no keys keeps `S`, so its types are the ones the schema alone gives.
 *
 * @typeParam S - Schema
 * @typeParam D - The `limits` literal
 */
export type Bounded<S extends QuerySchema, D extends Limits> = NoLimits extends D
  ? S
  : S & { readonly "~limits": D };

/** Ceilings from `connect({ timeouts })`, in milliseconds. Each key is optional. */
export type Timeouts = DriverTimeouts;

/** What `hookm.onTransaction` hears. `depth` is 0 for the transaction and 1 and up for savepoints. */
export type TransactionEvent = {
  readonly phase: "start" | "commit" | "rollback";
  readonly depth: number;
};

/**
 * A read-only observer (spec §18).
 *
 * Events only. An error a hook throws is dropped and never reaches the call.
 */
export type Hookm = {
  /** A server notice, such as `RAISE NOTICE`. */
  onNotice?(notice: Notice): void;
  /** A transaction or batch starts, commits, or rolls back. */
  onTransaction?(event: TransactionEvent): void;
  /** An error the runtime could not give to a caller, such as one from an `afterCommit` callback. */
  onError?(error: unknown): void;
};
