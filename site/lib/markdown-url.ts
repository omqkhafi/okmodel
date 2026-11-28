/**
 * Handbook URLs for agents. Markdown twins live under `/llms.mdx/docs`.
 */

import { SITE_ORIGIN } from "./site-identity";

/**
 * Absolute URL on the site origin. `http(s)` values pass through.
 *
 * @param path - Site path beginning with `/`, or an absolute URL
 * @param origin - Override for tests
 */
export function absoluteDocsUrl(path: string, origin: string = SITE_ORIGIN): string {
  if (path.startsWith("https://") || path.startsWith("http://")) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${origin.replace(/\/$/, "")}${normalized}`;
}

/**
 * Per-page markdown path.
 *
 * @param slugs - Docs slug segments. Empty is the introduction.
 */
export function markdownPathForSlugs(slugs: readonly string[]): string {
  if (slugs.length === 0) return "/llms.mdx/docs/index.md";
  const last = slugs.at(-1);
  if (last === undefined) return "/llms.mdx/docs/index.md";
  const head = slugs.slice(0, -1);
  return head.length > 0
    ? `/llms.mdx/docs/${head.join("/")}/${last}.md`
    : `/llms.mdx/docs/${last}.md`;
}

/**
 * Markdown twin for a handbook href, hash preserved.
 *
 * @param href - `/docs` path, optional `#anchor`
 */
export function markdownPathForHref(href: string): string {
  const hashAt = href.indexOf("#");
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";
  const path = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (normalized === "/docs" || normalized === "/docs/") return `/llms.mdx/docs/index.md${hash}`;
  if (!normalized.startsWith("/docs/")) return `${normalized}${hash}`;
  const rest = normalized.slice("/docs/".length);
  if (rest.length === 0) return `/llms.mdx/docs/index.md${hash}`;
  return `/llms.mdx/docs/${rest}.md${hash}`;
}
