/**
 * Accept: text/markdown rewrites handbook URLs to their markdown twins.
 */

import { expect, test } from "bun:test";

import { markdownNegotiation, markdownTwinPath } from "./markdown-negotiate";

test("a docs path negotiates to its markdown twin", () => {
  expect(markdownTwinPath("/docs/quickstart")).toBe("/llms.mdx/docs/quickstart.md");
  expect(markdownTwinPath("/docs")).toBe("/llms.mdx/docs/index.md");
  expect(markdownTwinPath("/docs/guides/install")).toBe("/llms.mdx/docs/guides/install.md");
  expect(markdownTwinPath("/")).toBe("/llms.mdx/home");
  expect(markdownTwinPath("/changelog")).toBe("/llms.mdx/releases");

  const request = new Request("https://okmodel.omqkhafi.dev/docs/quickstart", {
    headers: { accept: "text/markdown" },
  });
  expect(markdownNegotiation(request)).toEqual({
    kind: "rewrite",
    pathname: "/llms.mdx/docs/quickstart.md",
  });
});

test("html and machine routes are not rewritten", () => {
  const html = new Request("https://okmodel.omqkhafi.dev/docs/quickstart", {
    headers: { accept: "text/html" },
  });
  expect(markdownNegotiation(html)).toEqual({ kind: "pass" });

  const sitemap = new Request("https://okmodel.omqkhafi.dev/sitemap.xml", {
    headers: { accept: "text/markdown" },
  });
  expect(markdownNegotiation(sitemap)).toEqual({ kind: "pass" });
});
