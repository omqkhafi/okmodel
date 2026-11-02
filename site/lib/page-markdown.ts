/**
 * Handbook page markdown read from `content/docs`. Build time only (the
 * routes using it are prerendered): it reads the repository, so `source.ts`,
 * which `/api/search` loads per request, must not import it.
 */

import { readDocsSourceBody } from "./markdown-source";
import { type source, withMarkdownTwinIndex } from "./source";

/**
 * Page markdown for agents: the page body, with the title as the heading.
 *
 * @param page - Loaded page
 */
export async function getPageSourceMarkdown(
  page: (typeof source)["$inferPage"],
): Promise<string> {
  const body = await readDocsSourceBody(page.path);
  return withMarkdownTwinIndex(`# ${page.data.title}\n\n${body.trim()}\n`);
}

/**
 * One page inside `llms-full.txt`.
 *
 * @param page - Loaded page
 */
export async function getLLMText(page: (typeof source)["$inferPage"]): Promise<string> {
  const body = await readDocsSourceBody(page.path);
  return withMarkdownTwinIndex(`# ${page.data.title} (${page.url})\n\n${body.trim()}\n`);
}
