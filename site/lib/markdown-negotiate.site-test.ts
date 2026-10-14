/**
 * Accept: text/markdown rewrites handbook URLs to their markdown twins.
 */

import { expect, test } from "bun:test";

import { markdownNegotiation, markdownTwinPath } from "./markdown-negotiate";

test("a docs path negotiates to its markdown twin", () => {
  expect(markdownTwinPath("/docs/start")).toBe("/llms.mdx/docs/start.md");
  expect(markdownTwinPath("/docs")).toBe("/llms.mdx/docs/index.md");
  expect(markdownTwinPath("/docs/define/config")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/config")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/config/file")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/schema/tables")).toBe("/llms.mdx/docs/define/schema.md");
  expect(markdownTwinPath("/docs/table/columns")).toBe("/llms.mdx/docs/define/table.md");
  expect(markdownTwinPath("/docs/start/query")).toBe("/llms.mdx/docs/start.md");
  expect(markdownTwinPath("/docs/start/install")).toBe("/llms.mdx/docs/start.md");
  expect(markdownTwinPath("/docs/model/queries")).toBe("/llms.mdx/docs/define/table.md");
  expect(markdownTwinPath("/docs/start/queries")).toBe("/llms.mdx/docs/define/table.md");
  expect(markdownTwinPath("/docs/model/schema")).toBe("/llms.mdx/docs/define/table.md");
  expect(markdownTwinPath("/docs/model/safety")).toBe("/llms.mdx/docs/define/table.md");
  expect(markdownTwinPath("/docs/ship/migrations")).toBe("/llms.mdx/docs/define/config.md");
  expect(markdownTwinPath("/docs/ship/drivers")).toBe("/llms.mdx/docs/define/connect.md");
  expect(markdownTwinPath("/docs/known-limits")).toBe("/llms.mdx/docs/index.md");
  expect(markdownTwinPath("/docs/reference/known-limits")).toBe("/llms.mdx/docs/index.md");
  expect(markdownTwinPath("/docs/reference/linter")).toBe("/llms.mdx/docs/index.md");
  expect(markdownTwinPath("/")).toBe("/llms.mdx/home");
  expect(markdownTwinPath("/changelog")).toBe("/llms.mdx/releases");

  const request = new Request("https://okmodel.omqkhafi.dev/docs/start", {
    headers: { accept: "text/markdown" },
  });
  expect(markdownNegotiation(request)).toEqual({
    kind: "rewrite",
    pathname: "/llms.mdx/docs/start.md",
  });
});

test("html and machine routes are not rewritten", () => {
  const html = new Request("https://okmodel.omqkhafi.dev/docs/start", {
    headers: { accept: "text/html" },
  });
  expect(markdownNegotiation(html)).toEqual({ kind: "pass" });

  const sitemap = new Request("https://okmodel.omqkhafi.dev/sitemap.xml", {
    headers: { accept: "text/markdown" },
  });
  expect(markdownNegotiation(sitemap)).toEqual({ kind: "pass" });
});
