/**
 * Permanent redirects for handbook URLs shipped in 0.10.0 (README, error
 * bodies, and package docs). Kept minimal; only `site/next.config.ts` mounts
 * this list. `permanent: true` is HTTP 308.
 */

/** One Next.js redirect entry. */
export type DocsRedirect = {
  readonly source: string;
  readonly destination: string;
  readonly permanent: true;
};

/**
 * Specific retired paths first, then the `/docs/define` catch-all.
 * Order matters: Next applies the first match. An empty list resolves nothing.
 */
export const DOCS_REDIRECTS: readonly DocsRedirect[] = [
  {
    source: "/docs/define/table/validation",
    destination: "/docs/schema/validation",
    permanent: true,
  },
  {
    source: "/docs/define/schema/tenancy",
    destination: "/docs/schema/tenancy",
    permanent: true,
  },
  {
    source: "/docs/define/table/queries",
    destination: "/docs/queries/search-and-trees",
    permanent: true,
  },
  {
    source: "/docs/define/table/presets",
    destination: "/docs/queries/presets",
    permanent: true,
  },
  {
    source: "/docs/define/table/traits",
    destination: "/docs/schema/traits",
    permanent: true,
  },
  {
    source: "/docs/start/basic-usage",
    destination: "/docs/start/first-schema",
    permanent: true,
  },
  {
    source: "/docs/start/from-drizzle",
    destination: "/docs/migrations/from-drizzle",
    permanent: true,
  },
  {
    source: "/docs/define/:path*",
    destination: "/docs",
    permanent: true,
  },
];

/**
 * Destination for one path, using the first matching redirect.
 *
 * `:path*` at the end of a source captures the rest. A table with no rows
 * returns undefined.
 *
 * @param pathname - Request path, no query
 * @param table - Redirects in match order. Defaults to {@link DOCS_REDIRECTS}
 * @returns The destination, or undefined when nothing matches
 */
export function resolveRedirect(
  pathname: string,
  table: readonly DocsRedirect[] = DOCS_REDIRECTS,
): string | undefined {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  for (const entry of table) {
    const destination = matchRedirect(path, entry);
    if (destination !== undefined) return destination;
  }
  return undefined;
}

/**
 * Page URLs plus any redirect destination that is not already a page.
 *
 * Sources are not listed. An empty redirect table leaves the page list as it is.
 *
 * @param urls - Absolute page URLs already in the sitemap
 * @param redirects - Redirect table
 * @param origin - Site origin, no trailing slash
 * @returns Absolute URLs, page order first
 */
export function withRedirectDestinations(
  urls: readonly string[],
  redirects: readonly DocsRedirect[],
  origin: string,
): string[] {
  const seen = new Set(urls);
  const extra: string[] = [];
  for (const entry of redirects) {
    if (entry.destination.includes(":") || entry.destination.includes("*")) continue;
    const url = `${origin}${entry.destination}`;
    if (seen.has(url)) continue;
    seen.add(url);
    extra.push(url);
  }
  return [...urls, ...extra];
}

/**
 * Whether Next will redirect this path. The proxy must pass it through so
 * the 308 still happens.
 *
 * @param pathname - Request pathname
 */
export function isDocsRedirect(pathname: string): boolean {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return DOCS_REDIRECTS.some((entry) => matchRedirect(path, entry) !== undefined);
}

function matchRedirect(pathname: string, entry: DocsRedirect): string | undefined {
  const star = entry.source.indexOf(":");
  if (star < 0) return pathname === entry.source ? entry.destination : undefined;
  if (entry.source.slice(star) !== ":path*") return undefined;
  const prefix = entry.source.slice(0, star);
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (rest.length === 0) return undefined;
  if (entry.destination.includes(":path*")) return entry.destination.replace(":path*", rest);
  return entry.destination;
}
