/**
 * Shared operand for `matches` and `relevance`.
 *
 * Both helpers store this shape. The SQL compiler reads it once, so `search`
 * and the two helpers emit the same text.
 */

import type { MatchValue, SearchMatch } from "../operators.js";

/** Options `matches` and `relevance` take. */
export type SearchOptions = {
  /** How to match. Omitted means `natural`. */
  readonly match?: SearchMatch;
  /** Text search language, such as `english`. Omitted uses the database default. */
  readonly language?: string;
};

/**
 * Stores the text, the match, and the language.
 *
 * @param query - Text to look for
 * @param options - Match and language. Omitted means natural, database language
 * @returns The operand both helpers tag
 */
export function searchValue(query: string, options?: SearchOptions): MatchValue {
  return {
    query,
    match: options?.match ?? "natural",
    language: options?.language,
  };
}
