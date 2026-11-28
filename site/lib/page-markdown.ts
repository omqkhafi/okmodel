/**
 * Per-page markdown twin. {@link renderPageMarkdown} is the generator.
 */

import { renderPageMarkdown } from "./agent-docs";
import type { source } from "./source";

/**
 * Page markdown for agents: source URL, title, summary, chip line, then the body.
 *
 * @param page - Loaded page
 */
export async function getPageSourceMarkdown(
  page: (typeof source)["$inferPage"],
): Promise<string> {
  return renderPageMarkdown(page.url);
}
