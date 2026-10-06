/**
 * Types for a connected client.
 *
 * Row shapes are the schema's `~row`. Operators are the tagged helpers.
 * A plain object is not a where value when the column type is an object.
 */

import type { DriverTimeouts, Notice } from "../contracts/driver.js";
import type { SafeResult } from "../contracts/error.js";
import type { QuerySchema } from "../dialects/pg/model.js";
import type { Inc } from "../dialects/pg/ops/inc.js";
import type {
  ArrAppend,
  ArrRemove,
  JsonSet,
  Or,
  RelationFilter,
} from "../dialects/pg/operators.js";
import type { FieldWhere, IsJsonObject } from "../dialects/pg/where.js";
import type { AppliedRule, ReadOp } from "./plan.js";

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

/** `has`, `none`, and `every` against the related row. */
export type RelFilter<S extends QuerySchema, Rel> = Rel extends {
  readonly table: infer T extends string;
}
  ? T extends keyof S["~byName"]
    ? RelationFilter<"has" | "none" | "every", FieldWhere<RowOf<S, T>>>
    : never
  : never;

/** Known relation names. A string index (no declared relations) adds none. */
type RelationKeys<R> = string extends keyof R ? never : keyof R;

/** Column and relation filters for one table. */
type FiltersOf<S extends QuerySchema, K extends keyof S["~byName"]> = FieldWhere<RowOf<S, K>> & {
  readonly [R in RelationKeys<RelationsOf<S, K>>]?: RelFilter<S, RelationsOf<S, K>[R]> | undefined;
};

/** `where` for one table. `or()` may be the whole filter. */
export type WhereOf<S extends QuerySchema, K extends keyof S["~byName"]> =
  | FiltersOf<S, K>
  | Or<FiltersOf<S, K>>;

/** `orderBy`. `asc` is nulls last and `desc` is nulls first unless `nulls` is set. */
export type OrderBy<Row> = {
  readonly [K in keyof Row]?:
    | "asc"
    | "desc"
    | { readonly dir: "asc" | "desc"; readonly nulls?: "first" | "last" }
    | undefined;
};

type Related<S extends QuerySchema, T extends keyof S["~byName"], Opt> = Opt extends {
  readonly select: infer Sel;
}
  ? Selected<RowOf<S, T>, Sel>
  : RowOf<S, T>;

/** One include. To-many needs `limit`. */
export type IncludeOf<S extends QuerySchema, K extends keyof S["~byName"]> = {
  readonly [R in RelationKeys<RelationsOf<S, K>>]?: RelationsOf<S, K>[R] extends {
    readonly kind: "many";
    readonly table: infer T extends string;
  }
    ? T extends keyof S["~byName"]
      ? {
          readonly limit: number;
          readonly select?: readonly (keyof RowOf<S, T> & string)[];
          readonly where?: FieldWhere<RowOf<S, T>>;
          readonly orderBy?: OrderBy<RowOf<S, T>>;
        }
      : never
    : RelationsOf<S, K>[R] extends { readonly kind: "one"; readonly table: infer T extends string }
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

/** Columns kept by `select`. The full row when `select` is omitted. */
export type Selected<Row, Sel> = [Sel] extends [readonly (infer P)[]]
  ? [P] extends [keyof Row]
    ? { readonly [K in P & keyof Row]: Row[K] }
    : Row
  : Row;

type IncludeRows<S extends QuerySchema, K extends keyof S["~byName"], Inc> = [Inc] extends [
  Record<string, unknown>,
]
  ? {
      readonly [R in keyof Inc & keyof RelationsOf<S, K>]: RelationsOf<S, K>[R] extends {
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

/** Options shared by reads. */
export type ReadOptions<S extends QuerySchema, K extends keyof S["~byName"]> = CallOptions & {
  readonly where?: WhereOf<S, K>;
  readonly select?: readonly (keyof RowOf<S, K> & string)[];
  readonly orderBy?: OrderBy<RowOf<S, K>>;
  readonly include?: IncludeOf<S, K>;
};

/**
 * Row locks on `find`. They exist inside `tx()` only (OKM1830 outside one).
 *
 * `wait` says what happens when a row is locked by another transaction: `nowait`
 * fails at once (kind `lock_timeout`) and `skip` leaves that row out.
 */
export type LockOptions = {
  readonly lock?: "update" | "share";
  readonly wait?: "nowait" | "skip";
};

/** `find` options. `limit` is required unless the caller uses `.all(reason)`. */
export type FindOptions<S extends QuerySchema, K extends keyof S["~byName"]> = ReadOptions<S, K> & {
  readonly limit?: number;
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
  /** Streams rows when the driver has `stream`. Otherwise OKM1111. */
  stream(): AsyncIterable<T extends readonly (infer R)[] ? R : T>;
};

/** One page: the rows, and the cursor for the next page. `next` is `null` on the last page. */
export type Page<Row> = {
  readonly items: readonly Row[];
  readonly next: string | null;
};

/** `page` options. `after` is the `next` of the page before. */
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

/** `aggregate` options. A hidden field is refused at runtime. */
export type AggregateOptions<S extends QuerySchema, K extends keyof S["~byName"]> = CallOptions & {
  readonly where?: WhereOf<S, K>;
  /** One result row per distinct combination. Needs `limit`, or `.all(reason)`. */
  readonly groupBy?: readonly (keyof RowOf<S, K> & string)[];
  /** Adds `count`, the number of rows in the group. */
  readonly count?: true;
  readonly sum?: readonly NumericKeys<RowOf<S, K>>[];
  readonly avg?: readonly NumericKeys<RowOf<S, K>>[];
  readonly min?: readonly (keyof RowOf<S, K> & string)[];
  readonly max?: readonly (keyof RowOf<S, K> & string)[];
  /** Orders the groups. Only `groupBy` fields. Without it, groups come in `groupBy` order. */
  readonly orderBy?: OrderBy<RowOf<S, K>>;
  readonly limit?: number;
};

/** A group: its fields, and the aggregates the call named. */
export type AggregateRow<Row, O> = Show<
  (O extends { readonly groupBy: readonly (infer G)[] } ? Pick<Row, G & keyof Row> : unknown) &
    (O extends { readonly count: true } ? { readonly count: number } : unknown) &
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

/**
 * Required keys of an insert row.
 *
 * A key whose value includes `undefined` is optional. Marking it required makes
 * the editor offer only the property under the cursor (D139).
 *
 * @typeParam T - Insert shape
 */
export type RequiredInsert<T> = {
  readonly [K in keyof T as undefined extends T[K] ? never : K]: T[K];
};

/**
 * Optional keys of an insert row.
 *
 * @typeParam T - Insert shape
 */
export type OptionalInsert<T> = {
  readonly [K in keyof T as undefined extends T[K] ? K : never]?: T[K];
};

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

/** `set` values. `undefined` leaves the field unchanged. `inc` adds to it. `set` and `arr` write json and arrays. */
export type UpdateSet<S extends QuerySchema, K extends keyof S["~byName"]> = {
  readonly [F in keyof UpdateOf<S, K>]?:
    | UpdateOf<S, K>[F]
    | Inc<NonNullable<UpdateOf<S, K>[F]>>
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
  readonly returning?: readonly (keyof RowOf<S, K> & string)[];
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

/** A write handle. Await it, or read its SQL before it runs. */
export type Write<T> = Promise<T> & {
  /** Statement text and parameters, one entry per chunk. */
  sql(): Promise<{
    readonly statements: readonly {
      readonly text: string;
      readonly params?: readonly (string | null)[];
    }[];
  }>;
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
  | { readonly where?: WhereOf<S, K>; readonly set: AllowedSet<S, K, Allow> }
  | readonly {
      readonly id?: unknown;
      readonly where?: WhereOf<S, K>;
      readonly set: AllowedSet<S, K, Allow>;
    }[];

/** One update, or a per-row list in one statement. */
export type UpdateTarget<S extends QuerySchema, K extends keyof S["~byName"]> =
  | { readonly where?: WhereOf<S, K>; readonly set: UpdateSet<S, K> }
  | readonly {
      readonly id?: unknown;
      readonly where?: WhereOf<S, K>;
      readonly set: UpdateSet<S, K>;
    }[];

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
  find<const O extends FindOptions<S, K> & L>(
    options: O,
  ): { all(reason: string): Read<readonly ResultRow<S, K, O>[]> };
  one<const O extends ReadOptions<S, K>>(options?: O): Read<ResultRow<S, K, O> | null>;
  /**
   * One page of rows and the cursor for the next.
   *
   * Keyset on `orderBy` plus the primary key, so a page is stable while rows
   * are inserted. Pass `next` back as `after` with the same `orderBy`.
   */
  page<const O extends PageOptions<S, K>>(options: O): Query<Page<ResultRow<S, K, O>>>;
  /**
   * Counts, sums, averages, and finds extremes, per group.
   *
   * The tenant and active-set rules apply as in `find`.
   */
  aggregate<
    const O extends AggregateOptions<S, K> &
      ({ readonly limit: number } | { readonly groupBy?: undefined }),
  >(
    options: O,
  ): Query<readonly AggregateRow<RowOf<S, K>, O>[]>;
  aggregate<const O extends AggregateOptions<S, K>>(
    options: O,
  ): { all(reason: string): Query<readonly AggregateRow<RowOf<S, K>, O>[]> };
  count(options?: CallOptions & { readonly where?: WhereOf<S, K> }): Read<number>;
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
   * Rows may carry different keys. An omitted key or an explicit `undefined` takes the
   * database default for that row; `null` stays NULL.
   */
  insert(
    data: readonly (RequiredInsert<InsertOf<S, K>> & OptionalInsert<InsertOf<S, K>>)[],
    options?: InsertOptions<S, K>,
  ): Write<readonly Show<RowOf<S, K>>[]>;
  /** Updates matching rows, or a per-row list in one statement. `where` is required. */
  update<const Allow extends readonly (keyof RowOf<S, K> & string)[]>(
    target: AllowedUpdate<S, K, Allow>,
    options: WriteOptions<S, K> & { readonly allow: Allow },
  ): Write<WriteCount>;
  update(target: UpdateTarget<S, K>, options?: WriteOptions<S, K>): Write<WriteCount>;
  /** Deletes matching rows. `where` is required. */
  delete(
    target: { readonly where?: WhereOf<S, K> },
    options?: WriteOptions<S, K>,
  ): Write<WriteCount>;
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

/** A client whose tables are already inside one tenant or an unscoped reason. */
type ScopedClient<S extends QuerySchema> = {
  readonly [K in keyof S["~byName"] & string]: TableApi<S, K>;
} & {
  /** Looks up a table by name. An unknown name is OKM1120. */
  table<K extends keyof S["~byName"] & string>(name: K): TableApi<S, K>;
  /** Closes the pool when this client opened it. */
  close(): Promise<void>;
  /** Resolves when the dialect and `requires` checks have finished. */
  readonly connected: Promise<void>;
} & TxApi<S, false> &
  IfAsyncDisposable<typeof Symbol>;

/** `for` and `unscoped` on a schema that set tenancy. */
type ScopeMethods<S extends QuerySchema> =
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
        for(input: { readonly [K in TenantKeyOf<S>]: string }): ScopedClient<S>;
        /**
         * Opens a client with no tenant predicate.
         *
         * The reason is stored and shown by `inspect()`. Insert still needs `for()`.
         *
         * @param reason - Why this client leaves the tenant scope
         */
        unscoped(reason: string): ScopedClient<S>;
      };

/** A client typed by its own schema. */
export type Connected<S extends QuerySchema> = {
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
} & TxApi<S, true> &
  ScopeMethods<S> &
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
export type ConnectOptions<S extends QuerySchema> = {
  readonly schema: S;
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
};

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
