/**
 * Equality-only filter type.
 *
 * Kept out of `operators.ts` so the type-cost baseline does not also check the
 * tagged-operator union.
 */

/**
 * A filter that accepts the column value or `null`.
 *
 * @typeParam TColumns - Column value types
 */
export type EqWhere<TColumns extends Record<string, unknown>> = {
  readonly [K in keyof TColumns]?: TColumns[K] | null;
};
