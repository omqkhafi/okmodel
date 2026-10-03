import { tag, type MatchMode, type Matches } from "../operators.js";

/**
 * Full-text match (`@@`) for a tsvector column.
 *
 * The default mode is `websearch_to_tsquery`, which does not throw on user
 * input. `"plain"` uses `plainto_tsquery` and `"phrase"` uses `phraseto_tsquery`.
 * A text column is not searched here.
 *
 * @param query - Search text
 * @param options - Mode and regconfig name
 * @returns A tagged operator
 */
export function matches(
  query: string,
  options?: { readonly mode?: MatchMode; readonly config?: string },
): Matches {
  return tag("matches", {
    query,
    mode: options?.mode ?? "websearch",
    config: options?.config,
  });
}
