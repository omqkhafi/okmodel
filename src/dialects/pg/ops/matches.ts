import { tag, type Matches } from "../operators.js";
import { searchValue, type SearchOptions } from "./search-query.js";

/**
 * Full-text match for a search column.
 *
 * The default match is natural, which does not throw on user input. A plain
 * text column is not searched here. `relevance` orders by the same match.
 *
 * @param query - Text to look for
 * @param options - How to match, and the text search language
 * @returns A tagged operator for `where`
 */
export function matches(query: string, options?: SearchOptions): Matches {
  return tag("matches", searchValue(query, options));
}
