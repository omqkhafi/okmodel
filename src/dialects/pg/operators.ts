/**
 * Tagged filter operators (spec §10.1, D125).
 *
 * The brand is a symbol. JSON cannot create one, so request data cannot add
 * an operator or traverse a relation. A plain object stays OKM1121.
 */

declare const brand: unique symbol;

const RUNTIME = Symbol("okmodel.operator");

/** Operator names the read path compiles. */
export type OperatorName =
  | "eq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "between"
  | "startsWith"
  | "contains"
  | "endsWith"
  | "like"
  | "ilike"
  | "inList"
  | "notIn"
  | "not"
  | "or"
  | "and"
  | "has"
  | "none"
  | "every"
  | "inc"
  | "containedBy"
  | "overlaps"
  | "hasKey"
  | "hasAnyKey"
  | "path"
  | "matches"
  | "similar"
  | "wordSimilar"
  | "json.set"
  | "arr.append"
  | "arr.remove";

/** A tagged operator. `value` is the operand the helper stored. */
export type Tagged<Name extends OperatorName, V> = {
  readonly [brand]: Name;
  readonly value: V;
};

/** Equality, including json and jsonb (D125). */
export type Eq<V> = Tagged<"eq", V>;

/** One-sided comparison. */
export type Compare<Name extends "lt" | "lte" | "gt" | "gte", V> = Tagged<Name, V>;

/** Inclusive range. */
export type Between<V> = Tagged<"between", readonly [V, V]>;

/** A literal pattern. `%`, `_`, and `\` in the value are escaped. */
export type Pattern<Name extends "startsWith" | "contains" | "endsWith"> = Tagged<Name, string>;

/** Array, jsonb, or range containment (`@>` or `<@`). */
export type Containment<Name extends "contains" | "containedBy", V> = Tagged<Name, V>;

/** Array or range overlap (`&&`). */
export type Overlaps<V> = Tagged<"overlaps", V>;

/** One jsonb key (`jsonb_exists`). */
export type HasKey = Tagged<"hasKey", string>;

/** Any of these jsonb keys (`jsonb_exists_any`). */
export type HasAnyKey = Tagged<"hasAnyKey", readonly string[]>;

/** A comparison applied to a json path (`#>>`). */
export type PathCompare<V> = Eq<V> | Compare<"lt" | "lte" | "gt" | "gte", V>;

/** Path segments and the comparison applied to the extracted text. */
export type PathValue<V> = {
  readonly segments: readonly string[];
  readonly op: PathCompare<V>;
};

/** `col #>> segments` compared with `op`. */
export type Path<V extends string | number | boolean> = Tagged<"path", PathValue<V>>;

/** How `matches` turns query text into a tsquery. */
export type MatchMode = "websearch" | "plain" | "phrase";

/** Full-text query. `config` is a regconfig name when set. */
export type MatchValue = {
  readonly query: string;
  readonly mode: MatchMode;
  readonly config: string | undefined;
};

/** `@@` against a tsvector column. */
export type Matches = Tagged<"matches", MatchValue>;

/** Text stored on a `pg_trgm` operator. `schema` is the extension's install schema. */
export type TrigramQuery = {
  readonly query: string;
  readonly schema: string;
};

/** `pg_trgm` `%` or `<%`. */
export type Trigram<Name extends "similar" | "wordSimilar"> = Tagged<Name, TrigramQuery>;

/** `jsonb_set` path and the new value. */
export type JsonSetValue<V> = {
  readonly path: readonly string[];
  readonly value: V;
};

/** Atomic JSON path write (`json.set`). */
export type JsonSet<V> = Tagged<"json.set", JsonSetValue<V>>;

/** `array_append` of one element. */
export type ArrAppend<V> = Tagged<"arr.append", V>;

/** `array_remove` of one element. */
export type ArrRemove<V> = Tagged<"arr.remove", V>;

/** A raw `LIKE` or `ILIKE` pattern. The caller owns the wildcards. */
export type RawPattern<Name extends "like" | "ilike"> = Tagged<Name, string>;

/** Membership. An empty list matches nothing. */
export type InList<V> = Tagged<"inList", readonly V[]>;

/** The complement of {@link InList}. An empty list matches everything. */
export type NotIn<V> = Tagged<"notIn", readonly V[]>;

/** Negation of null, a value, or another operator. */
export type Not<V> = Tagged<"not", V>;

/** Disjunction. Each branch is a where object. */
export type Or<V> = Tagged<"or", readonly V[]>;

/** A relation filter. The value is the related table's where. */
export type RelationFilter<Name extends "has" | "none" | "every", V> = Tagged<Name, V>;

type AnyTagged = {
  readonly [RUNTIME]: OperatorName;
  readonly value: unknown;
};

/**
 * Reports whether `value` is a tagged operator.
 *
 * @param value - A where operand
 * @returns `true` when a helper created it
 */
export function isOperator(value: unknown): value is AnyTagged {
  return typeof value === "object" && value !== null && RUNTIME in value;
}

/**
 * Reads the operator name.
 *
 * @param value - A value {@link isOperator} accepted
 * @returns The helper that created it
 */
export function operatorName(value: AnyTagged): OperatorName {
  return value[RUNTIME];
}

/**
 * Reads the operand.
 *
 * @param value - A value {@link isOperator} accepted
 * @returns The operand the helper stored
 */
export function operatorValue(value: AnyTagged): unknown {
  return value.value;
}

/**
 * Tags an operator. Each helper lives in its own module so unused ones drop out.
 *
 * @typeParam Name - Operator name
 * @typeParam V - Operand
 * @param name - Operator name
 * @param value - Operand
 * @returns A tagged operator
 */
export function tag<Name extends OperatorName, V>(name: Name, value: V): Tagged<Name, V> {
  return { [RUNTIME]: name, value } as unknown as Tagged<Name, V>;
}
