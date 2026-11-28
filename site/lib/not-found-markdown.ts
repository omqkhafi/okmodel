/**
 * Machine-readable 404 body. Agents that send `Accept: text/markdown` get
 * this instead of the HTML not-found page. Nearby pages come from the
 * search index.
 */

import { absoluteDocsUrl, markdownPathForHref } from "./markdown-url";
import { markdownResponse } from "./markdown-response";
import { NOT_FOUND_LINKS } from "./not-found-links";
import { suggestPages } from "./search-docs";

/**
 * Markdown 404 pointing at nearby pages, the handbook, the agent index, and
 * the sitemap.
 *
 * @param path - Request path. Empty skips suggestions.
 */
export function markdownNotFoundBody(path: string = ""): string {
  const safe = path.replace(/[^\w./~-]/g, "").slice(0, 200);
  const suggestions = safe.length === 0 ? [] : suggestPages(safe);
  const lines = ["# Not found", "", `No page matched \`${safe.length > 0 ? safe : "/"}\`.`, ""];
  if (suggestions.length > 0) {
    lines.push("## Nearby pages", "");
    for (const hit of suggestions) {
      const note = hit.summary.length > 0 ? `: ${hit.summary}` : "";
      lines.push(`- [${hit.title}](${absoluteDocsUrl(markdownPathForHref(hit.url))})${note}`);
    }
    lines.push("");
  }
  for (const link of NOT_FOUND_LINKS) lines.push(`- [${link.title}](${link.href})`);
  lines.push("");
  return lines.join("\n");
}

/**
 * 404 markdown response with `Content-Type: text/markdown` and `Vary: Accept`.
 *
 * @param path - Request path, when the caller knows it
 */
export function markdownNotFoundResponse(path: string = ""): Response {
  return markdownResponse(markdownNotFoundBody(path), 404);
}
