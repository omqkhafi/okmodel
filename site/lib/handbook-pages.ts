/**
 * Handbook page lookup for request-time code. The list is bundled, so the
 * proxy never touches the filesystem (on Vercel only `site/` is deployed).
 * Regenerate with `bun ./site/scripts/handbook-paths.ts --write`.
 */

import paths from "./handbook-paths.json";

let pages: ReadonlySet<string> | undefined;

/**
 * Whether the handbook has a page at this path (no hash check).
 *
 * @param pathname - `/docs` or `/docs/…`
 */
export function docsPageExists(pathname: string): boolean {
  pages ??= new Set(paths);
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return pages.has(path);
}
