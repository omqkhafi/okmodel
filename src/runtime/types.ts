/**
 * Types for a connected client.
 *
 * Row shapes are the schema's `~row`. Operators are the tagged helpers.
 * A plain object is not a where value when the column type is an object.
 */

import type { SafeResult } from "../contracts/error.js";
import type { QuerySchema } from "../dialects/pg/model.js";
import type { Inc } from "../dialects/pg/ops/inc.js";
import type {
  Between,
  Compare,
  Eq,
  InList,
  Not,
  NotIn,
  Or,
  Pattern,
  RawPattern,
  RelationFilter,
} from "../dialects/pg/operators.js";
import type { AppliedRule, ReadOp } from "./plan.js";

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

type IsObject<V> = V extends object
  ? V extends readonly unknown[]
    ? false
    : null extends V
      ? false
      : true
  : false;

/** A where operand. Object columns take `eq`, not a bare object. */
export type WhereValue<V> =
  | (IsObject<V> extends true ? never : V)
  | null
  | Eq<V>
  | Compare<"lt", V>
  | Compare<"lte", V>
  | Compare<"gt", V>
  | Compare<"gte", V>
  | Between<V>
  | Pattern<"startsWith">
  | Pattern<"contains">
  | Pattern<"endsWith">
  | RawPattern<"like">
  | RawPattern<"ilike">
  | InList<V>
  | NotIn<V>
  | Not<V | null | Pattern<"startsWith"> | Pattern<"contains"> | Pattern<"endsWith"> | InList<V>>;

/** Field filters. Relation filters are one level, so the type does not cycle. */
export type FieldWhere<Row> = {
  readonly [K in keyof Row]?: WhereValue<Row[K]> | undefined;
};

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

/** Options shared by reads. */
export type ReadOptions<S extends QuerySchema, K extends keyof S["~byName"]> = {
  readonly where?: WhereOf<S, K>;
  readonly select?: readonly (keyof RowOf<S, K> & string)[];
  readonly orderBy?: OrderBy<RowOf<S, K>>;
  readonly include?: IncludeOf<S, K>;
};

/** `find` options. `limit` is required unless the caller uses `.all(reason)`. */
export type FindOptions<S extends QuerySchema, K extends keyof S["~byName"]> = ReadOptions<S, K> & {
  readonly limit?: number;
};

/** A query handle. Await it, or inspect it before it runs. */
export type Read<T> = Promise<T> & {
  /** Logical intent, rules, plan, SQL, parameters, and the routing decision. */
  inspect(): Inspection | Promise<Inspection>;
  /** Statement text and parameters. */
  sql():
    | { readonly text: string; readonly params: readonly (string | null)[] }
    | Promise<{ readonly text: string; readonly params: readonly (string | null)[] }>;
  /** `{ ok, value }` or `{ ok, error }`. */
  safe(): Promise<SafeResult<T>>;
  /** Allows `find` or a to-many include without `limit`. */
  all(reason: string): Read<T>;
  /** Turns a null `one()` into `not_found`. */
  required(): Read<NonNullable<T>>;
  /** Streams rows when the driver has `stream`. Otherwise OKM1111. */
  stream(): AsyncIterable<T extends readonly (infer R)[] ? R : T>;
};

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

/** `set` values. `undefined` leaves the field unchanged. `inc` adds to it. */
export type UpdateSet<S extends QuerySchema, K extends keyof S["~byName"]> = {
  readonly [F in keyof UpdateOf<S, K>]?: UpdateOf<S, K>[F] | Inc<NonNullable<UpdateOf<S, K>[F]>>;
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
  readonly expect?: number;
  readonly signal?: AbortSignal;
  readonly timeout?: number;
};

/** Options for `update` and `delete`. */
export type WriteOptions<S extends QuerySchema, K extends keyof S["~byName"]> = {
  readonly returning?: readonly (keyof RowOf<S, K> & string)[];
  readonly expect?: number;
  readonly signal?: AbortSignal;
  readonly timeout?: number;
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

/** One update, or a per-row list in one statement. */
export type UpdateTarget<S extends QuerySchema, K extends keyof S["~byName"]> =
  | { readonly where?: WhereOf<S, K>; readonly set: UpdateSet<S, K> }
  | readonly {
      readonly id?: unknown;
      readonly where?: WhereOf<S, K>;
      readonly set: UpdateSet<S, K>;
    }[];

/** Methods on one table. */
export type TableApi<S extends QuerySchema, K extends keyof S["~byName"] & string> = {
  find<const O extends FindOptions<S, K> & { readonly limit: number }>(
    options: O,
  ): Read<readonly ResultRow<S, K, O>[]>;
  find<const O extends FindOptions<S, K>>(
    options: O,
  ): { all(reason: string): Read<readonly ResultRow<S, K, O>[]> };
  one<const O extends ReadOptions<S, K>>(options?: O): Read<ResultRow<S, K, O> | null>;
  count(options?: { readonly where?: WhereOf<S, K> }): Read<number>;
  exists(options?: { readonly where?: WhereOf<S, K> }): Read<boolean>;
  /** Inserts one row or a list. Unknown keys are dropped. The list is one transaction. */
  insert(data: InsertOf<S, K>, options?: InsertOptions<S, K>): Write<Show<RowOf<S, K>>>;
  /** Inserts one row or a list. Unknown keys are dropped. The list is one transaction. */
  insert(
    data: readonly InsertOf<S, K>[],
    options?: InsertOptions<S, K>,
  ): Write<readonly Show<RowOf<S, K>>[]>;
  /** Updates matching rows, or a per-row list in one statement. `where` is required. */
  update(target: UpdateTarget<S, K>, options?: WriteOptions<S, K>): Write<WriteCount>;
  /** Deletes matching rows. `where` is required. */
  delete(
    target: { readonly where?: WhereOf<S, K> },
    options?: WriteOptions<S, K>,
  ): Write<WriteCount>;
};

/** A client typed by its own schema. */
export type Connected<S extends QuerySchema> = {
  readonly [K in keyof S["~byName"] & string]: TableApi<S, K>;
} & {
  /** Looks up a table by name. An unknown name is OKM1120. */
  table<K extends keyof S["~byName"] & string>(name: K): TableApi<S, K>;
  /** Closes the pool when this client opened it. */
  close(): Promise<void>;
  /** Resolves when the dialect and `requires` checks have finished. */
  readonly connected: Promise<void>;
};

/** `connect` options shared by the Postgres drivers. */
export type ConnectOptions<S extends QuerySchema> = {
  readonly schema: S;
  readonly logger?: {
    error?(entry: { readonly code: string; readonly summary: string }): void;
  };
  readonly errors?: {
    readonly http?: import("../contracts/error.js").ErrorStatuses;
    readonly includeValues?: boolean;
  };
  readonly signal?: AbortSignal;
  readonly timeout?: number;
};
