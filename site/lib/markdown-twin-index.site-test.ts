/**
 * Every handbook markdown twin points at /llms.txt.
 */

import { expect, test } from "bun:test";

import {
  getPageSourceMarkdown,
  MARKDOWN_TWIN_INDEX_LINE,
  source,
  withMarkdownTwinIndex,
} from "./source";

test("withMarkdownTwinIndex adds the pointer when missing", () => {
  expect(withMarkdownTwinIndex("# Title\n\nBody.\n")).toBe(
    `# Title\n\nBody.\n\n${MARKDOWN_TWIN_INDEX_LINE}\n`,
  );
  expect(withMarkdownTwinIndex(`# Title\n\nSee [/llms.txt](/llms.txt).\n`)).toContain("/llms.txt");
  expect(withMarkdownTwinIndex(`# Title\n\nSee [/llms.txt](/llms.txt).\n`)).not.toContain(
    `${MARKDOWN_TWIN_INDEX_LINE}\n\n${MARKDOWN_TWIN_INDEX_LINE}`,
  );
});

test("every public page twin names llms.txt", async () => {
  const pages = source.getPages();
  expect(pages.length).toBeGreaterThan(0);
  for (const page of pages) {
    const markdown = await getPageSourceMarkdown(page);
    expect(markdown.includes("/llms.txt"), page.url).toBe(true);
  }
});
