import { tag, type Relevance } from "../operators.js";
import { searchValue, type SearchOptions } from "./search-query.js";

/**
 * Orders a search column by how well it matches.
 *
 * Most relevant first. Pass it as an `orderBy` value. `find({ search })`
 * compiles to `matches` plus this, so the SQL is the same.
 *
 * @param query - Text to look for
 * @param options - How to match, and the text search language. Same words as `matches`
 * @returns A tagged order
 */
export function relevance(query: string, options?: SearchOptions): Relevance {
  return tag("relevance", searchValue(query, options));
}
