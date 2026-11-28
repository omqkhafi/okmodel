/**
 * Where-value types shared by the client and by presets.
 *
 * They sit in the dialect layer so `table({ presets })` can type a preset's
 * `where` without importing the client types. `runtime/types.ts` re-exports
 * the two names callers use.
 */

import type {
  Between,
  Compare,
  Containment,
  Eq,
  HasAnyKey,
  HasKey,
  InList,
  Matches,
  Trigram,
  Within,
  Not,
  NotIn,
  Overlaps,
  Adjacent,
  Before,
  After,
  IsEmpty,
  Path,
  Pattern,
  RawPattern,
} from "./operators.js";
import type { Range } from "./range.js";

export type IsObject<V> = V extends string
  ? false
  : V extends object
    ? V extends readonly unknown[]
      ? false
      : null extends V
        ? false
        : true
    : false;

/** Text patterns, including substring `contains`. `matches` is for tsvector, which is also `string`. */
type TextOps =
  | Pattern<"startsWith">
  | Pattern<"contains">
  | Pattern<"endsWith">
  | RawPattern<"like">
  | RawPattern<"ilike">
  | Matches
  | Trigram<"similar">
  | Trigram<"wordSimilar">;

/** Array, jsonb, or range containment, plus overlap where that operator fits. */
type StructuredOps<V> = Containment<"contains" | "containedBy", V> | Overlaps<V>;

/** `[lower, upper)` when `V` is a range object or a list of them. Otherwise `never`. */
type RangeTupleOf<V> = V extends readonly (infer E)[]
  ? [RangeLeaf<E>] extends [never]
    ? never
    : readonly RangeLeaf<E>[]
  : RangeLeaf<V>;

type RangeLeaf<V> = V extends { readonly empty: false; readonly lower: infer L }
  ? readonly [L | null, L | null]
  : never;

/** Range position operators. `contains` also accepts an element of the subtype. */
type RangeOps<V> =
  | StructuredOps<V | RangeTupleOf<V>>
  | Adjacent<V | RangeTupleOf<V>>
  | Before<V | RangeTupleOf<V>>
  | After<V | RangeTupleOf<V>>
  | IsEmpty
  | Containment<"contains", unknown>;

/** A JSON fragment. Containment matches part of a document, not the whole column type. */
type JsonFragment =
  | string
  | number
  | boolean
  | null
  | readonly JsonFragment[]
  | { readonly [key: string]: JsonFragment };

/** jsonb and json filters. `hasKey` is rejected at runtime on json. */
type JsonOps =
  | Containment<"contains" | "containedBy", JsonFragment>
  | HasKey
  | HasAnyKey
  | Path<string>
  | Path<number>
  | Path<boolean>;

/**
 * A plain object that can be json or jsonb.
 *
 * Arrays, ranges, and bytea are not json. Timestamp values are objects too, and
 * the Temporal declarations are structural, so a timestamp column is rejected
 * at runtime (OKM1124) rather than here.
 */
export type IsJsonObject<V> = V extends readonly unknown[]
  ? false
  : V extends Range<unknown>
    ? false
    : V extends Uint8Array
      ? false
      : IsObject<V>;

/** Operators the column value type can accept. `unknown` keeps every family and the runtime decides. */
type TypedOps<V> = [unknown] extends [V]
  ? TextOps | StructuredOps<V> | JsonOps
  :
      | (V extends string ? TextOps : never)
      | (V extends readonly number[] ? Within : never)
      | (V extends readonly unknown[] ? StructuredOps<V> : never)
      | (V extends Range<unknown> ? RangeOps<V> : never)
      | (IsJsonObject<V> extends true ? JsonOps : never);

/** A where operand. Object columns take `eq`, not a bare object. */
export type WhereValue<V> = V extends unknown
  ?
      | (IsObject<V> extends true ? never : V)
      | null
      | Eq<V>
      | Compare<"lt", V>
      | Compare<"lte", V>
      | Compare<"gt", V>
      | Compare<"gte", V>
      | Between<V>
      | InList<V>
      | NotIn<V>
      | Not<V | null | TextOps | InList<V>>
      | TypedOps<V>
  : never;

/** Field filters. Relation filters are one level, so the type does not cycle. */
export type FieldWhere<Row> = {
  readonly [K in keyof Row]?: WhereValue<Row[K]> | undefined;
};
