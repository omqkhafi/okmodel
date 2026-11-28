/**
 * Per-code markdown and the Errors page index.
 *
 * The HTML Errors page keeps its anchors. Its `.md` twin is the index: one
 * line per code. `GET /docs/reference/errors/<CODE>.md` is only that code.
 * `llms-errors.txt` is not generated. It would repeat this index, and the
 * reference section file already includes the index as the Errors page.
 */

import { ERROR_FIXES } from "./generated/error-fixes";
import { handbookPages, type HandbookPage } from "./handbook-corpus";
import { errorCodeMarkdownUrl, errorCodePageUrl } from "./error-code-path";
import { absoluteDocsUrl, markdownPathForHref } from "./markdown-url";
import { withMarkdownTwinIndex } from "./source";

/** One code's markdown stays under this many characters. */
export const ERROR_CODE_CHAR_LIMIT = 20_000;

/** The Errors index stays under the agent-file limit. */
export const ERROR_INDEX_CHAR_LIMIT = 100_000;

const byCode = new Map(ERROR_FIXES.map((row) => [row.code, row]));

/**
 * Markdown for one code: source line, kind, summary, fix, related pages.
 *
 * @param code - `OKM####`
 * @returns The twin, or `undefined` when the code is not in the registry
 */
export function renderErrorCodeMarkdown(code: string): string | undefined {
  const row = byCode.get(code);
  if (row === undefined) return undefined;
  const lines = [
    `Source: ${absoluteDocsUrl(errorCodePageUrl(code))}`,
    "",
    `# ${code}`,
    "",
    `> ${oneLine(row.summary)}`,
    "",
    `Kind: \`${row.kind}\`.`,
    "",
    "## Fix",
    "",
    row.fix,
    "",
    "## Related pages",
    "",
  ];
  const related = relatedPages(code);
  if (related.length === 0) lines.push("None.", "");
  else {
    for (const page of related) {
      const note = oneLine(page.summary);
      const href = absoluteDocsUrl(markdownPathForHref(page.url));
      lines.push(note.length > 0 ? `- [${page.title}](${href}): ${note}` : `- [${page.title}](${href})`);
    }
    lines.push("");
  }
  return withMarkdownTwinIndex(lines.join("\n"));
}

/**
 * Errors page markdown: one line per code, linking at that code's twin.
 *
 * @param summary - Page summary
 */
export function renderErrorIndexMarkdown(summary: string): string {
  const lines = [
    `Source: ${absoluteDocsUrl("/docs/reference/errors")}`,
    "",
    "# Errors",
    "",
    `> ${oneLine(summary)}`,
    "",
    "Each code is one page. A line here is the code, the kind, and the summary.",
    "",
  ];
  for (const row of ERROR_FIXES) {
    const href = absoluteDocsUrl(errorCodeMarkdownUrl(row.code));
    lines.push(`- [\`${row.code}\`](${href}) \`${row.kind}\`: ${oneLine(row.summary)}`);
  }
  lines.push("");
  return withMarkdownTwinIndex(lines.join("\n"));
}

/**
 * Handbook pages other than Errors whose body names this code.
 *
 * @param code - `OKM####`
 */
function relatedPages(code: string): readonly HandbookPage[] {
  return handbookPages().filter(
    (page) => page.url !== "/docs/reference/errors" && page.codes.includes(code),
  );
}

/**
 * Collapse whitespace to one line.
 *
 * @param value - Source text
 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
