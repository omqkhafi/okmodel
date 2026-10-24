/**
 * The redirect map is the only place permanent handbook redirects are listed.
 */

import { expect, test } from "bun:test";

import { DOCS_REDIRECTS, docsRedirectEntries, redirectPathname } from "./docs-redirects";

test("every redirect destination has a pathname", () => {
  for (const [source, destination] of Object.entries(DOCS_REDIRECTS)) {
    expect(source.startsWith("/docs/"), source).toBe(true);
    expect(redirectPathname(destination).startsWith("/docs"), destination).toBe(true);
  }
  expect(docsRedirectEntries().length).toBe(Object.keys(DOCS_REDIRECTS).length);
});

test("known-limits and linter are not in the redirect map", () => {
  expect(Object.hasOwn(DOCS_REDIRECTS, "/docs/known-limits")).toBe(false);
  expect(Object.hasOwn(DOCS_REDIRECTS, "/docs/reference/known-limits")).toBe(false);
  expect(Object.hasOwn(DOCS_REDIRECTS, "/docs/reference/linter")).toBe(false);
});
