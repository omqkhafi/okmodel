/**
 * Accept: text/markdown rewrites handbook URLs to their markdown twins.
 */

import { expect, test } from "bun:test";

import { markdownNegotiation, markdownTwinPath } from "./markdown-negotiate";
import { source } from "./source";

test("every handbook page negotiates to its markdown twin", () => {
  const pages = source.getPages();
  expect(pages.length).toBeGreaterThan(0);
  for (const page of pages) {
    const twin = page.url === "/docs" ? "/llms.mdx/docs/index.md" : `/llms.mdx${page.url}.md`;
    expect(markdownTwinPath(page.url), page.url).toBe(twin);
  }
  expect(markdownTwinPath("/")).toBe("/llms.mdx/home");
  expect(markdownTwinPath("/changelog")).toBe("/llms.mdx/releases");

  const sample = pages.find((page) => page.url === "/docs/start") ?? pages[0];
  if (sample === undefined) throw new Error("the handbook has no pages");
  const pathname = markdownTwinPath(sample.url);
  if (pathname === undefined) throw new Error(`no twin for ${sample.url}`);
  const request = new Request(`https://okm.omqkhafi.dev${sample.url}`, {
    headers: { accept: "text/markdown" },
  });
  expect(markdownNegotiation(request)).toEqual({ kind: "rewrite", pathname });
});

test("an unknown docs path has no twin so Accept: text/markdown 404s", () => {
  expect(markdownTwinPath("/docs/reference/linter")).toBeUndefined();
  expect(markdownTwinPath("/docs/define/table/validation")).toBeUndefined();
  expect(markdownTwinPath("/docs/nope")).toBeUndefined();
  const request = new Request("https://okm.omqkhafi.dev/docs/nope", {
    headers: { accept: "text/markdown" },
  });
  expect(markdownNegotiation(request)).toEqual({ kind: "not-found" });
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
