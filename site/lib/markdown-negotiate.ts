/**
 * Accept negotiation map — HTML handbook URLs rewrite to their markdown twins.
 * The Next.js `proxy.ts` is the request-time entry; this module is the pure
 * decision so tests do not need `next/server`.
 */

import { isMarkdownPreferred } from "fumadocs-core/negotiation";

/** Result of inspecting one request for markdown negotiation. */
export type MarkdownAction =
  | { readonly kind: "rewrite"; readonly pathname: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "pass" };

/**
 * Markdown twin for an HTML handbook path, or `undefined` when this URL is not
 * a negotiated HTML page.
 *
 * @param pathname - Request pathname (no query)
 */
export function markdownTwinPath(pathname: string): string | undefined {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  if (path === "/") return "/llms.mdx/home";

  if (path === "/docs") return "/llms.mdx/docs/index.md";
  if (path === "/docs/start/query" || path === "/docs/start/install") return "/llms.mdx/docs/start.md";
  if (path === "/docs/model/schema") return "/llms.mdx/docs/define/table.md";
  if (path === "/docs/model/safety") return "/llms.mdx/docs/define/table/visibility.md";
  if (path === "/docs/model/queries" || path === "/docs/start/queries") {
    return "/llms.mdx/docs/define/table/queries.md";
  }
  if (path === "/docs/ship/migrations") return "/llms.mdx/docs/define/config.md";
  if (path === "/docs/ship/drivers") return "/llms.mdx/docs/define/connect.md";
  if (path === "/docs/known-limits" || path.startsWith("/docs/reference/")) return "/llms.mdx/docs/index.md";
  if (path === "/docs/config" || path.startsWith("/docs/config/")) return "/llms.mdx/docs/define/config.md";
  if (path === "/docs/schema" || path.startsWith("/docs/schema/")) return "/llms.mdx/docs/define/schema.md";
  if (path === "/docs/table" || path.startsWith("/docs/table/")) return tableMarkdownTwin(path);
  if (path.startsWith("/docs/")) {
    const rest = path.slice("/docs/".length);
    if (rest.length === 0) return "/llms.mdx/docs/index.md";
    return `/llms.mdx/docs/${rest}.md`;
  }

  if (path === "/changelog") return "/llms.mdx/releases";
  if (path.startsWith("/changelog/")) {
    const rest = path.slice("/changelog/".length);
    if (rest.length === 0) return "/llms.mdx/releases";
    return `/llms.mdx/releases/${rest}`;
  }

  return undefined;
}

/** Old `/docs/table/...` paths, one markdown file per Table page. */
const TABLE_PAGES = new Set([
  "keys",
  "columns",
  "defaults",
  "shape",
  "names",
  "visibility",
  "validation",
  "references",
  "relations",
  "indexes",
  "checks",
  "filters",
  "traits",
  "tenancy",
  "presets",
  "reference-rows",
  "queries",
]);

/**
 * Markdown twin for a retired `/docs/table` URL.
 *
 * @param path - Request pathname without a trailing slash
 */
function tableMarkdownTwin(path: string): string {
  if (path === "/docs/table") return "/llms.mdx/docs/define/table.md";
  const rest = path.slice("/docs/table/".length);
  const slug = rest === "reference" ? "reference-rows" : rest;
  if (TABLE_PAGES.has(slug)) return `/llms.mdx/docs/define/table/${slug}.md`;
  return "/llms.mdx/docs/define/table.md";
}

/**
 * Paths that already have a single representation — do not 404 them when
 * Accept prefers markdown.
 *
 * @param pathname - Request pathname
 */
export function isUnnegotiatedPath(pathname: string): boolean {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (path.startsWith("/_next")) return true;
  if (path.startsWith("/api/")) return true;
  if (path.startsWith("/og/")) return true;
  if (path.startsWith("/llms")) return true;
  if (path === "/json" || path.startsWith("/json/")) return true;
  if (path === "/sitemap.xml" || path === "/robots.txt") return true;
  if (path === "/icon.svg" || path === "/favicon.ico") return true;
  return false;
}

/**
 * Decide whether this request should be rewritten, 404'd as markdown, or left
 * to the App Router.
 *
 * @param request - Incoming request (needs `url` + `Accept`)
 */
export function markdownNegotiation(request: Request): MarkdownAction {
  if (!isMarkdownPreferred(request)) return { kind: "pass" };
  const pathname = new URL(request.url).pathname;
  const twin = markdownTwinPath(pathname);
  if (twin !== undefined) return { kind: "rewrite", pathname: twin };
  if (isUnnegotiatedPath(pathname)) return { kind: "pass" };
  return { kind: "not-found" };
}
