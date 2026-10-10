/**
 * Machine-readable 404 body. Agents that send `Accept: text/markdown` get
 * this instead of the HTML not-found page.
 */

import { markdownResponse } from "./markdown-response";

/**
 * Markdown 404 pointing at the handbook, the agent index, and the sitemap.
 */
export function markdownNotFoundBody(): string {
  return `# Not found

No page matched this path.

- [Documentation](/docs)
- [llms.txt](/llms.txt)
- [sitemap.xml](/sitemap.xml)
`;
}

/**
 * 404 markdown response with `Content-Type: text/markdown` and `Vary: Accept`.
 */
export function markdownNotFoundResponse(): Response {
  return markdownResponse(markdownNotFoundBody(), 404);
}
