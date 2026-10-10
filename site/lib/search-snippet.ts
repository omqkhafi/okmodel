/**
 * Search excerpts arrive as a short markdown string with `<mark>` around
 * the match. Rendering that through a markdown parser pulls micromark into
 * the client. This keeps the mark and drops every other tag.
 */

/** One slice of an excerpt, either plain text or the highlighted match. */
export interface SnippetPart {
  readonly mark: boolean;
  readonly text: string;
}

/**
 * Split an excerpt into text and mark slices.
 *
 * @param content - Excerpt from the search API
 */
export function searchSnippet(content: string): readonly SnippetPart[] {
  const plain = content.replace(/<(?!\/?mark\b)[^>]*>/g, "");
  const parts: SnippetPart[] = [];
  const pattern = /<mark>([\s\S]*?)<\/mark>/g;
  let last = 0;
  for (const match of plain.matchAll(pattern)) {
    const index = match.index;
    if (index > last) parts.push({ mark: false, text: plain.slice(last, index) });
    parts.push({ mark: true, text: match[1] ?? "" });
    last = index + match[0].length;
  }
  if (last < plain.length) parts.push({ mark: false, text: plain.slice(last) });
  return parts;
}

/** One search hit the dialog can link to. */
export interface SearchHit {
  readonly id: string;
  readonly url: string;
  readonly content: string;
}

/**
 * Keep hits that have a URL and an excerpt. The empty-query sentinel and
 * action items are dropped.
 *
 * @param data - `query.data` from `useDocsSearch`
 */
export function searchHits(data: unknown): readonly SearchHit[] {
  if (!Array.isArray(data)) return [];
  const hits: SearchHit[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.url !== "string" || typeof record.content !== "string") continue;
    const id = typeof record.id === "string" ? record.id : record.url;
    hits.push({ id, url: record.url, content: record.content });
  }
  return hits;
}
