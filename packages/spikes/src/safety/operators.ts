/**
 * Tagged filter operators.
 *
 * Helpers stamp a unique symbol. `JSON.parse` cannot produce that symbol, so a
 * request body cannot invent an operator or a relation traversal. A plain
 * object where a scalar value is expected is rejected (OKM1121).
 */

import { SafetyError, violation } from "./errors.js";

const operatorBrand: unique symbol = Symbol("okmodel.operator");

/** Operator names from spec section 10.1. */
export const OPERATOR_NAMES = [
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
  "startsWith",
  "contains",
  "inList",
  "not",
  "has",
  "none",
  "every",
  "or",
] as const;

/** A tagged operator name. */
export type OperatorName = (typeof OPERATOR_NAMES)[number];

/**
 * A value created by an operator helper.
 *
 * @typeParam TName - Operator name
 * @typeParam TValue - Operand
 */
export type TaggedOperator<TName extends OperatorName, TValue> = {
  readonly [operatorBrand]: TName;
  readonly value: TValue;
};

/**
 * What a filter slot accepts.
 *
 * A bare object is not in this type. Object-shaped column values are still
 * rejected at runtime; see the findings on OKM1121. Relation and `or` nodes
 * are interfaces so the type may mention itself.
 *
 * @typeParam T - Column value
 */
export type FilterValue<T> =
  | T
  | null
  | TaggedOperator<"lt", T>
  | TaggedOperator<"lte", T>
  | TaggedOperator<"gt", T>
  | TaggedOperator<"gte", T>
  | TaggedOperator<"between", readonly [T, T]>
  | TaggedOperator<"inList", readonly T[]>
  | TaggedOperator<"startsWith", T>
  | TaggedOperator<"contains", T>
  | TaggedOperator<"not", T | null>
  | HasOperator
  | NoneOperator
  | EveryOperator
  | OrOperator<T>;

/** `has` relation filter. Nested slots use {@link FilterValue}. */
export interface HasOperator {
  readonly [operatorBrand]: "has";
  readonly value: Readonly<Record<string, FilterValue<unknown>>>;
}

/** `none` relation filter. */
export interface NoneOperator {
  readonly [operatorBrand]: "none";
  readonly value: Readonly<Record<string, FilterValue<unknown>>>;
}

/** `every` relation filter. */
export interface EveryOperator {
  readonly [operatorBrand]: "every";
  readonly value: Readonly<Record<string, FilterValue<unknown>>>;
}

/**
 * Disjunction.
 *
 * @typeParam T - Operand type
 */
export interface OrOperator<T> {
  readonly [operatorBrand]: "or";
  readonly value: readonly FilterValue<T>[];
}

/**
 * Filter object whose values may be tagged operators.
 *
 * @typeParam TColumns - Column value types
 */
export type Where<TColumns extends Record<string, unknown>> = {
  readonly [K in keyof TColumns]?: FilterValue<TColumns[K]>;
};

/**
 * Result of reading one filter input.
 *
 * `skip` is `undefined` on a read. `null` is `IS NULL`. Scalars are equality.
 */
export type ReadFilter =
  | { readonly kind: "skip" }
  | { readonly kind: "null" }
  | { readonly kind: "eq"; readonly value: string | number | boolean | bigint }
  | { readonly kind: "op"; readonly op: OperatorName; readonly value: unknown };

const OPERATOR_SET: ReadonlySet<string> = new Set(OPERATOR_NAMES);

/**
 * Less than.
 *
 * @typeParam T - Operand type
 * @param value - Operand
 * @returns A tagged operator
 */
export function lt<T>(value: T): TaggedOperator<"lt", T> {
  return tag("lt", value);
}

/**
 * Less than or equal.
 *
 * @typeParam T - Operand type
 * @param value - Operand
 * @returns A tagged operator
 */
export function lte<T>(value: T): TaggedOperator<"lte", T> {
  return tag("lte", value);
}

/**
 * Greater than.
 *
 * @typeParam T - Operand type
 * @param value - Operand
 * @returns A tagged operator
 */
export function gt<T>(value: T): TaggedOperator<"gt", T> {
  return tag("gt", value);
}

/**
 * Greater than or equal.
 *
 * @typeParam T - Operand type
 * @param value - Operand
 * @returns A tagged operator
 */
export function gte<T>(value: T): TaggedOperator<"gte", T> {
  return tag("gte", value);
}

/**
 * Inclusive range.
 *
 * @typeParam T - Endpoint type
 * @param low - Lower endpoint
 * @param high - Upper endpoint
 * @returns A tagged operator
 */
export function between<T>(low: T, high: T): TaggedOperator<"between", readonly [T, T]> {
  return tag("between", [low, high]);
}

/**
 * Prefix match.
 *
 * @typeParam T - Operand type
 * @param value - Prefix
 * @returns A tagged operator
 */
export function startsWith<T>(value: T): TaggedOperator<"startsWith", T> {
  return tag("startsWith", value);
}

/**
 * Substring match.
 *
 * @typeParam T - Operand type
 * @param value - Fragment
 * @returns A tagged operator
 */
export function contains<T>(value: T): TaggedOperator<"contains", T> {
  return tag("contains", value);
}

/**
 * Membership.
 *
 * @typeParam T - Element type
 * @param values - Allowed values
 * @returns A tagged operator
 */
export function inList<T>(values: readonly T[]): TaggedOperator<"inList", readonly T[]> {
  return tag("inList", values);
}

/**
 * Negation of a comparison or of `null`.
 *
 * @typeParam T - Operand type
 * @param value - Operand
 * @returns A tagged operator
 */
export function not<T>(value: T | null): TaggedOperator<"not", T | null> {
  return tag("not", value);
}

/**
 * Relation filter: at least one related row matches.
 *
 * @param where - Nested field filters
 * @returns A tagged operator
 */
export function has(where: Readonly<Record<string, FilterValue<unknown>>>): HasOperator {
  return tag("has", where);
}

/**
 * Relation filter: no related row matches.
 *
 * @param where - Nested field filters
 * @returns A tagged operator
 */
export function none(where: Readonly<Record<string, FilterValue<unknown>>>): NoneOperator {
  return tag("none", where);
}

/**
 * Relation filter: every related row matches.
 *
 * @param where - Nested field filters
 * @returns A tagged operator
 */
export function every(where: Readonly<Record<string, FilterValue<unknown>>>): EveryOperator {
  return tag("every", where);
}

/**
 * Disjunction of filter values.
 *
 * @typeParam T - Operand type
 * @param values - Branches
 * @returns A tagged operator
 */
export function or<T>(...values: readonly FilterValue<T>[]): OrOperator<T> {
  return tag("or", values);
}

/**
 * Reports whether a value was created by an operator helper.
 *
 * @param value - Candidate
 * @returns True when the brand symbol is present and names a known operator
 */
export function isTaggedOperator(value: unknown): value is TaggedOperator<OperatorName, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (!Object.hasOwn(value, operatorBrand)) {
    return false;
  }
  const branded: unknown = Object.getOwnPropertyDescriptor(value, operatorBrand)?.value;
  return typeof branded === "string" && OPERATOR_SET.has(branded);
}

/**
 * Reads one `where` input.
 *
 * `undefined` skips the filter. `null` is `IS NULL`. Scalars are equality.
 * Tagged operators pass through. Any other object or array throws OKM1121.
 *
 * @param value - Runtime input
 * @returns The classification
 */
export function readFilterInput(value: unknown): ReadFilter {
  if (value === undefined) {
    return { kind: "skip" };
  }
  if (value === null) {
    return { kind: "null" };
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return { kind: "eq", value };
  }
  if (isTaggedOperator(value)) {
    const name = Object.getOwnPropertyDescriptor(value, operatorBrand)?.value;
    if (typeof name !== "string" || !isOperatorName(name)) {
      throw objectRejected();
    }
    return { kind: "op", op: name, value: value.value };
  }
  throw objectRejected();
}

function tag<TName extends OperatorName, TValue>(
  name: TName,
  value: TValue,
): TaggedOperator<TName, TValue> {
  return { [operatorBrand]: name, value };
}

function isOperatorName(name: string): name is OperatorName {
  return OPERATOR_SET.has(name);
}

function objectRejected(): SafetyError {
  return new SafetyError([
    violation(
      "OKM1121",
      "object",
      "",
      "A plain object where a value is expected is rejected. Operators come from helpers.",
      "caller",
    ),
  ]);
}
