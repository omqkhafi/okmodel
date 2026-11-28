import { NOT_FOUND_LINKS } from "@/lib/not-found-links";
import type { SearchResult } from "@/lib/search-docs";
import Link from "next/link";

/**
 * HTML document for the suggestion 404. The route handler returns this with
 * status 404. It does not import `react-dom/server`.
 *
 * @param path - Request path
 * @param suggestions - Closest handbook pages
 */
export function notFoundDocument(path: string, suggestions: readonly SearchResult[]): string {
  const nearby =
    suggestions.length === 0
      ? ""
      : `<h2>Nearby pages</h2><ul>${suggestions
          .map((hit) => {
            const href = hit.url.split("#")[0] ?? hit.url;
            return `<li><a href="${escapeHtml(href)}">${escapeHtml(hit.title)}</a></li>`;
          })
          .join("")}</ul>`;
  const label = path.length > 0 ? `No page matched ${escapeHtml(path)}.` : "No page matched this path.";
  const links = NOT_FOUND_LINKS.map((link) => `<li><a href="${link.href}">${escapeHtml(link.title)}</a></li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title></head><body><main><h1>Not found</h1><p>${label}</p>${nearby}<ul>${links}</ul></main></body></html>`;
}

/**
 * Escape text placed in HTML.
 *
 * @param value - Raw text
 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return "&quot;";
  });
}

/**
 * HTML 404. Nearby pages come from the search index. The same destinations
 * are in the markdown 404 body.
 *
 * @param path - Request path, when the proxy recorded one
 * @param suggestions - Closest handbook pages
 */
export function NotFoundView({
  path = "",
  suggestions = [],
}: {
  readonly path?: string;
  readonly suggestions?: readonly SearchResult[];
}) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-24">
      <h1 className="text-3xl tracking-tight">Not found</h1>
      <p className="mt-4 text-fd-muted-foreground">
        {path.length > 0 ? `No page matched ${path}.` : "No page matched this path."}
      </p>
      {suggestions.length > 0 ? (
        <>
          <h2 className="mt-8 text-sm font-medium">Nearby pages</h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {suggestions.map((hit) => (
              <li key={hit.url}>
                <Link href={hit.url.split("#")[0] ?? hit.url} className="underline-offset-4 hover:underline">
                  {hit.title}
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <ul className="mt-8 flex flex-col gap-2 text-sm">
        {NOT_FOUND_LINKS.map((link) => (
          <li key={link.href}>
            <Link href={link.href} className="underline-offset-4 hover:underline">
              {link.title}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
