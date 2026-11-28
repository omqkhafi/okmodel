/**
 * Handbook search. The index is the compiled pages: title, summary, headings,
 * public function names, option names, error codes, and a synonym table
 * seeded from the "I want to…" tasks.
 *
 * This module does not read the filesystem. `/api/search` imports it on
 * every request.
 */

import { handbookPages, type HandbookPage } from "./handbook-corpus";
import { absoluteDocsUrl, markdownPathForHref } from "./markdown-url";
import { DOCS_TASKS } from "./tasks";

/** One hit in the documented search response. */
export type SearchResult = {
  readonly title: string;
  readonly url: string;
  /** Absolute markdown URL. */
  readonly markdown: string;
  readonly summary: string;
  readonly section: string;
  /** Page-level support chip line. Empty when the page has no feature key. */
  readonly chip: string;
};

/** `GET /api/search` body. */
export type SearchResponse = {
  readonly query: string;
  readonly results: readonly SearchResult[];
};

/** How many hits the endpoint returns. */
const RESULT_LIMIT = 8;

const STOP = new Set([
  "a",
  "an",
  "the",
  "to",
  "and",
  "or",
  "of",
  "in",
  "on",
  "for",
  "with",
  "from",
  "when",
  "how",
  "see",
  "it",
  "its",
  "that",
  "this",
  "into",
  "by",
  "as",
  "at",
  "be",
  "is",
  "are",
  "your",
  "you",
  "one",
  "another",
  "add",
  "use",
]);

/** Phrases that must land even when the page title uses other words. */
const EXPLICIT_SYNONYMS: readonly (readonly [string, readonly string[]])[] = [
  ["rls", ["/docs/schema/policies", "/docs/schema/tenancy"]],
  ["row level security", ["/docs/schema/policies"]],
  ["row-level security", ["/docs/schema/policies"]],
  ["multi tenant", ["/docs/guides/multi-tenant", "/docs/schema/tenancy"]],
  ["multi-tenant", ["/docs/guides/multi-tenant", "/docs/schema/tenancy"]],
  ["multitenant", ["/docs/guides/multi-tenant", "/docs/schema/tenancy"]],
  ["queue", ["/docs/guides/queues-leases"]],
  ["queues", ["/docs/guides/queues-leases"]],
  ["lease", ["/docs/guides/queues-leases"]],
  ["leases", ["/docs/guides/queues-leases"]],
  ["pgvector", ["/docs/schema/extensions"]],
  ["vector", ["/docs/schema/extensions"]],
  ["tenant", ["/docs/schema/tenancy"]],
  ["enum", ["/docs/schema/enums-arrays-picklists"]],
  ["view", ["/docs/schema/views"]],
  ["trigger", ["/docs/schema/triggers"]],
  ["extension", ["/docs/schema/extensions"]],
  ["transaction", ["/docs/queries/transactions"]],
  ["watch", ["/docs/queries/watch"]],
];

let synonyms: Map<string, readonly string[]> | undefined;

/**
 * Search the handbook.
 *
 * @param query - Raw query text
 * @param limit - Maximum hits
 */
export function searchHandbook(query: string, limit: number = RESULT_LIMIT): readonly SearchResult[] {
  const normalized = normalize(query);
  if (normalized.length === 0) return [];
  const code = exactCode(normalized);
  const ranked = handbookPages()
    .map((page) => ({ page, score: scorePage(page, normalized, code) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.page.url.localeCompare(b.page.url));
  return ranked.slice(0, limit).map((item) => toResult(item.page, code));
}

/**
 * Documented JSON body for `GET /api/search?query=`.
 *
 * @param query - Raw query text
 */
export function searchResponse(query: string): SearchResponse {
  return { query, results: searchHandbook(query) };
}

/**
 * Closest pages for an unknown path. Path similarity and the search index
 * both vote. An empty path returns no suggestions.
 *
 * @param pathname - Request path
 * @param limit - Maximum suggestions
 */
export function suggestPages(pathname: string, limit: number = 5): readonly SearchResult[] {
  const path = pathname.trim();
  if (path.length === 0 || path === "/") return [];
  const segment = path.split("/").filter((part) => part.length > 0).at(-1) ?? "";
  const query = segment.replace(/[-_]+/g, " ");
  const fromSearch = new Map(searchHandbook(query, limit).map((hit, index) => [hit.url.split("#")[0] ?? hit.url, limit - index]));
  const ranked = handbookPages()
    .map((page) => ({
      page,
      score: pathSimilarity(path, page.url) + (fromSearch.get(page.url) ?? 0) * 10,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.page.url.localeCompare(b.page.url));
  return ranked.slice(0, limit).map((item) => toResult(item.page, null));
}

/**
 * Serialized index, for the size report. The response does not send this.
 */
export function searchIndexJson(): string {
  return JSON.stringify(
    handbookPages().map((page) => ({
      url: page.url,
      title: page.title,
      summary: page.summary,
      section: page.section,
      chip: page.chip,
      headings: page.headings,
      functions: page.functions,
      options: page.options,
      codes: page.codes,
    })),
  );
}

/**
 * Score one page against a normalized query.
 *
 * @param page - Handbook page
 * @param query - Normalized query
 * @param code - `OKM####` when the query is exactly a code
 */
function scorePage(page: HandbookPage, query: string, code: string | null): number {
  let score = 0;
  const title = normalize(page.title);
  const summary = normalize(page.summary);
  if (code !== null) {
    if (page.url === "/docs/reference/errors") score += 5000;
    if (page.codes.includes(code)) score += page.url === "/docs/reference/errors" ? 1000 : 200;
  }
  const targets = synonymTable().get(query);
  if (targets !== undefined) {
    const at = targets.indexOf(page.url);
    if (at === 0) score += 800;
    else if (at > 0) score += 400;
  }
  if (title === query) score += 400;
  else if (phraseHit(title, query)) score += 300;
  if (phraseHit(summary, query)) score += 120;
  for (const heading of page.headings) {
    if (phraseHit(heading, query)) score += 80;
  }
  if (page.functions.some((name) => normalize(name) === query)) score += 70;
  if (page.options.some((name) => normalize(name) === query)) score += 70;
  const tokens = query.split(" ").filter((token) => token.length > 1 && !STOP.has(token));
  for (const token of tokens) {
    if (title.includes(token)) score += 40;
    if (summary.includes(token)) score += 15;
    if (page.headings.some((heading) => normalize(heading).includes(token))) score += 12;
    if (page.functions.some((name) => normalize(name).includes(token))) score += 10;
    if (page.options.some((name) => normalize(name).includes(token))) score += 10;
    const bodyHits = countToken(normalize(page.body), token);
    score += Math.min(bodyHits, 12) * 3;
  }
  return score;
}

/**
 * JSON hit. A code query links the errors page at that code's anchor.
 *
 * @param page - Handbook page
 * @param code - Exact code, when the query is one
 */
function toResult(page: HandbookPage, code: string | null): SearchResult {
  const anchored = code !== null && page.url === "/docs/reference/errors";
  const url = anchored ? `${page.url}#${code.toLowerCase()}` : page.url;
  const markdownPath = markdownPathForHref(url);
  return {
    title: page.title,
    url,
    markdown: absoluteDocsUrl(markdownPath),
    summary: oneLine(page.summary),
    section: page.section,
    chip: page.chip,
  };
}

/**
 * Synonym table. Explicit phrases plus n-grams from the task list.
 */
function synonymTable(): Map<string, readonly string[]> {
  if (synonyms !== undefined) return synonyms;
  const map = new Map<string, string[]>();
  const add = (phrase: string, url: string): void => {
    const key = normalize(phrase);
    if (key.length < 2) return;
    const list = map.get(key) ?? [];
    if (!list.includes(url)) list.push(url);
    map.set(key, list);
  };
  for (const [phrase, urls] of EXPLICIT_SYNONYMS) {
    for (const url of urls) add(phrase, url);
  }
  const unigrams = new Map<string, string[]>();
  for (const task of DOCS_TASKS) {
    const url = task.href.split("#")[0] ?? task.href;
    add(task.task, url);
    const words = normalize(task.task)
      .split(" ")
      .filter((word) => word.length > 1 && !STOP.has(word));
    for (const word of words) {
      if (word.length < 4) continue;
      const list = unigrams.get(word) ?? [];
      list.push(url);
      unigrams.set(word, list);
    }
    for (let index = 0; index < words.length - 1; index += 1) {
      const first = words[index];
      const second = words[index + 1];
      if (first === undefined || second === undefined) continue;
      add(`${first} ${second}`, url);
      const third = words[index + 2];
      if (third !== undefined) add(`${first} ${second} ${third}`, url);
    }
  }
  for (const [word, urls] of unigrams) {
    const unique = [...new Set(urls)];
    const only = unique[0];
    if (unique.length === 1 && only !== undefined) add(word, only);
  }
  synonyms = map;
  return synonyms;
}

/**
 * `OKM1101` when the whole query is one code.
 *
 * @param query - Normalized query
 */
function exactCode(query: string): string | null {
  const match = /^okm(\d{4})$/.exec(query.replace(/\s/g, ""));
  const digits = match?.[1];
  return digits === undefined ? null : `OKM${digits}`;
}

/**
 * Lowercase, hyphens as spaces, punctuation dropped.
 *
 * @param value - Raw text
 */
/**
 * A phrase matches a title or heading as words, so "view" does not hit "overview".
 *
 * @param haystack - Raw text
 * @param query - Normalized query
 */
function phraseHit(haystack: string, query: string): boolean {
  const text = normalize(haystack);
  if (query.includes(" ")) return text.includes(query);
  return text.split(" ").some((word) => word === query || (query.length >= 4 && word.startsWith(query)));
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[-_/]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How many times a token appears as its own word.
 *
 * @param haystack - Normalized text
 * @param token - Normalized token
 */
function countToken(haystack: string, token: string): number {
  if (token.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(token, from);
    if (at < 0) break;
    const before = at === 0 || haystack[at - 1] === " ";
    const after = at + token.length === haystack.length || haystack[at + token.length] === " ";
    if (before && after) count += 1;
    from = at + token.length;
  }
  return count;
}

/**
 * Shared path segments plus a last-segment edit similarity, 0 to about 120.
 *
 * @param pathname - Requested path
 * @param url - Candidate page path
 */
function pathSimilarity(pathname: string, url: string): number {
  const left = pathname.split("/").filter((part) => part.length > 0);
  const right = url.split("/").filter((part) => part.length > 0);
  let score = 0;
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] === right[index]) score += 15;
  }
  const a = (left.at(-1) ?? "").replace(/[-_]/g, "");
  const b = (right.at(-1) ?? "").replace(/[-_]/g, "");
  if (a.length === 0 || b.length === 0) return score;
  if (a === b) return score + 80;
  const distance = levenshtein(a, b);
  const ratio = 1 - distance / Math.max(a.length, b.length);
  if (ratio >= 0.5) score += Math.round(ratio * 70);
  return score;
}

/**
 * Edit distance for short slugs.
 *
 * @param a - Left slug
 * @param b - Right slug
 */
function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const grid: number[] = new Array(rows * cols).fill(0);
  for (let row = 0; row < rows; row += 1) grid[row * cols] = row;
  for (let col = 0; col < cols; col += 1) grid[col] = col;
  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      const del = (grid[(row - 1) * cols + col] ?? 0) + 1;
      const ins = (grid[row * cols + col - 1] ?? 0) + 1;
      const sub = (grid[(row - 1) * cols + col - 1] ?? 0) + cost;
      grid[row * cols + col] = Math.min(del, ins, sub);
    }
  }
  return grid[rows * cols - 1] ?? 0;
}

/**
 * One line, whitespace collapsed.
 *
 * @param value - Summary or description
 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
