/**
 * Accept: text/markdown rewrites handbook URLs to their markdown twins.
 */

import { expect, test } from "bun:test";

import { DOCS_REDIRECTS } from "./docs-redirects";
import { markdownNegotiation, markdownTwinPath } from "./markdown-negotiate";

test("a docs path negotiates to its markdown twin", () => {
  expect(markdownTwinPath("/docs/start")).toBe("/llms.mdx/docs/start.md");
  expect(markdownTwinPath("/docs")).toBe("/llms.mdx/docs/index.md");
  expect(markdownTwinPath("/docs/define/config")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/define/config/schema")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/define/config/database")).toBe("/llms.mdx/docs/define/config/database.md");
  expect(markdownTwinPath("/docs/config")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/config/paths")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/config/targets")).toBe("/llms.mdx/docs/define/config/database.md");
  expect(markdownTwinPath("/docs/schema/tables")).toBe("/llms.mdx/docs/define/schema/tables.md");
  expect(markdownTwinPath("/docs/table/columns")).toBe("/llms.mdx/docs/define/table/columns.md");
  expect(markdownTwinPath("/docs/table/reference")).toBe("/llms.mdx/docs/define/table/reference-rows.md");
  expect(markdownTwinPath("/docs/start/query")).toBe("/llms.mdx/docs/start.md");
  expect(markdownTwinPath("/docs/start/from-drizzle")).toBe("/llms.mdx/docs/migrate/from-drizzle.md");
  expect(markdownTwinPath("/docs/ship/migrations")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/define/connect/close")).toBe("/llms.mdx/docs/define/connect.md");
  expect(markdownTwinPath("/docs/define/connect/pool")).toBe("/llms.mdx/docs/define/connect/session.md");
  expect(markdownTwinPath("/docs/ai/mcp")).toBe("/llms.mdx/docs/ai/skills.md");
  expect(markdownTwinPath("/docs/ai/skills")).toBe("/llms.mdx/docs/ai/skills.md");
  expect(markdownTwinPath("/")).toBe("/llms.mdx/home");
  expect(markdownTwinPath("/changelog")).toBe("/llms.mdx/releases");

  const request = new Request("https://okm.omqkhafi.dev/docs/start", {
    headers: { accept: "text/markdown" },
  });
  expect(markdownNegotiation(request)).toEqual({
    kind: "rewrite",
    pathname: "/llms.mdx/docs/start.md",
  });
});

test("retired known-limits and linter paths are not redirected", () => {
  expect(DOCS_REDIRECTS["/docs/known-limits"]).toBeUndefined();
  expect(DOCS_REDIRECTS["/docs/reference/known-limits"]).toBeUndefined();
  expect(DOCS_REDIRECTS["/docs/reference/linter"]).toBeUndefined();
  expect(markdownTwinPath("/docs/known-limits")).toBe("/llms.mdx/docs/known-limits.md");
});

test("html and machine routes are not rewritten", () => {
  const html = new Request("https://okm.omqkhafi.dev/docs/start", {
    headers: { accept: "text/html" },
  });
  expect(markdownNegotiation(html)).toEqual({ kind: "pass" });

  const sitemap = new Request("https://okm.omqkhafi.dev/sitemap.xml", {
    headers: { accept: "text/markdown" },
  });
  expect(markdownNegotiation(sitemap)).toEqual({ kind: "pass" });
});
