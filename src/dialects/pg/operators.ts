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
  | "has"
  | "none"
  | "every"
  | "inc";

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
