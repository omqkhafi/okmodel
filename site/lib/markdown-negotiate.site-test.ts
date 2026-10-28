/**
 * Accept: text/markdown rewrites handbook URLs to their markdown twins.
 */

import { expect, test } from "bun:test";

import { markdownNegotiation, markdownTwinPath } from "./markdown-negotiate";

test("a docs path negotiates to its markdown twin", () => {
  expect(markdownTwinPath("/docs/start")).toBe("/llms.mdx/docs/start.md");
  expect(markdownTwinPath("/docs")).toBe("/llms.mdx/docs/index.md");
  expect(markdownTwinPath("/docs/reference/config")).toBe("/llms.mdx/docs/reference/config.md");
  expect(markdownTwinPath("/docs/reference/config-database")).toBe(
    "/llms.mdx/docs/reference/config-database.md",
  );
  expect(markdownTwinPath("/docs/schema/tables")).toBe("/llms.mdx/docs/schema/tables.md");
  expect(markdownTwinPath("/docs/schema/the-schema")).toBe("/llms.mdx/docs/schema/the-schema.md");
  expect(markdownTwinPath("/docs/queries")).toBe("/llms.mdx/docs/queries.md");
  expect(markdownTwinPath("/docs/operate/connect")).toBe("/llms.mdx/docs/operate/connect.md");
  expect(markdownTwinPath("/docs/migrations/from-drizzle")).toBe(
    "/llms.mdx/docs/migrations/from-drizzle.md",
  );
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

test("an unknown docs path keeps its own twin", () => {
  expect(markdownTwinPath("/docs/known-limits")).toBe("/llms.mdx/docs/known-limits.md");
  expect(markdownTwinPath("/docs/reference/linter")).toBe("/llms.mdx/docs/reference/linter.md");
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
