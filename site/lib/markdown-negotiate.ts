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
  if (path === "/docs/start/from-drizzle") return "/llms.mdx/docs/migrate/from-drizzle.md";
  if (path === "/docs/start/from-existing") return "/llms.mdx/docs/migrate/from-existing.md";
  if (path === "/docs/model/schema") return "/llms.mdx/docs/define/table.md";
  if (path === "/docs/model/safety") return "/llms.mdx/docs/define/table/visibility.md";
  if (path === "/docs/model/queries" || path === "/docs/start/queries") {
    return "/llms.mdx/docs/define/table/queries.md";
  }
  if (path === "/docs/ship/migrations") return "/llms.mdx/docs/define/config.md";
  if (path === "/docs/ship/drivers") return "/llms.mdx/docs/define/connect/drivers.md";
  if (path === "/docs/define/schema/requires") {
    return "/llms.mdx/docs/define/schema/min-postgres.md";
  }
  if (path.startsWith("/docs/define/config/")) {
    const folded = defineConfigMarkdownTwin(path.slice("/docs/define/config/".length));
    if (folded !== undefined) return folded;
  }
  if (path.startsWith("/docs/define/connect/")) {
    const folded = connectMarkdownTwin(path.slice("/docs/define/connect/".length));
    if (folded !== undefined) return folded;
  }
  if (path === "/docs/known-limits" || path === "/docs/reference/known-limits" || path === "/docs/reference/linter") {
    return "/llms.mdx/docs/index.md";
  }
  if (path === "/docs/config" || path.startsWith("/docs/config/")) return configMarkdownTwin(path);
  if (path === "/docs/schema" || path.startsWith("/docs/schema/")) return schemaMarkdownTwin(path);
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

/** Config options that folded into `/docs/define/config`. */
const CONFIG_FOLDED = new Set([
  "schema",
  "tables",
  "migrations",
  "out",
  "timeouts",
  "pooler",
  "lint-from",
  "backfill",
  "namespace",
  "external",
]);

/** Config child pages that remain their own handbook pages. */
const CONFIG_PAGES = new Set(["database", "roles"]);

/** Retired config slugs whose public name changed. */
const CONFIG_SLUG_ALIASES: Readonly<Record<string, string>> = {
  targets: "database",
  paths: "schema",
  lint: "lint-from",
};

/**
 * Markdown twin for a `/docs/define/config/<slug>` URL after the fold.
 *
 * @param slug - Path after `/docs/define/config/`
 */
function defineConfigMarkdownTwin(slug: string): string | undefined {
  if (CONFIG_FOLDED.has(slug)) return "/llms.mdx/docs/define/config.md";
  return undefined;
}

/**
 * Markdown twin for a retired `/docs/config` URL.
 *
 * @param path - Request pathname without a trailing slash
 */
function configMarkdownTwin(path: string): string {
  if (path === "/docs/config" || path === "/docs/config/file") return "/llms.mdx/docs/define/config.md";
  const raw = path.slice("/docs/config/".length);
  const slug = CONFIG_SLUG_ALIASES[raw] ?? raw;
  if (CONFIG_FOLDED.has(slug)) return "/llms.mdx/docs/define/config.md";
  if (CONFIG_PAGES.has(slug)) return `/llms.mdx/docs/define/config/${slug}.md`;
  return "/llms.mdx/docs/define/config.md";
}

/**
 * Connect pages that folded into another page. The slug is the old child.
 * The value is the markdown twin of the page that now holds the topic.
 */
const CONNECT_FOLDED: Readonly<Record<string, string>> = {
  close: "/llms.mdx/docs/define/connect.md",
  pool: "/llms.mdx/docs/define/connect/session.md",
  prepared: "/llms.mdx/docs/define/connect/session.md",
  tls: "/llms.mdx/docs/define/connect/session.md",
  "search-path": "/llms.mdx/docs/define/connect/session.md",
  timeouts: "/llms.mdx/docs/define/connect/session.md",
  "require-meta": "/llms.mdx/docs/define/connect/check.md",
  catalog: "/llms.mdx/docs/define/connect/check.md",
};

/**
 * Markdown twin for a retired Connect child, or `undefined` when the slug is still a page.
 *
 * @param slug - Path after `/docs/define/connect/`
 */
function connectMarkdownTwin(slug: string): string | undefined {
  return CONNECT_FOLDED[slug];
}

/** Old `/docs/schema/...` paths, one markdown file per Schema page. */
const SCHEMA_PAGES = new Set([
  "tables",
  "casing",
  "codecs",
  "types",
  "defaults",
  "min-postgres",
  "traits",
  "tenancy",
  "validation",
  "extensions",
  "functions",
  "triggers",
  "views",
]);

/**
 * Markdown twin for a retired `/docs/schema` URL.
 *
 * @param path - Request pathname without a trailing slash
 */
function schemaMarkdownTwin(path: string): string {
  if (path === "/docs/schema") return "/llms.mdx/docs/define/schema.md";
  const slug = path.slice("/docs/schema/".length);
  if (slug === "requires") return "/llms.mdx/docs/define/schema/min-postgres.md";
  if (SCHEMA_PAGES.has(slug)) return `/llms.mdx/docs/define/schema/${slug}.md`;
  return "/llms.mdx/docs/define/schema.md";
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
