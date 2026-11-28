/**
 * No-JavaScript HTML and 404 suggestions.
 */

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { notFoundDocument, NotFoundView } from "../components/not-found/not-found-view";
import { SearchResults } from "../components/search-results";
import { markdownNotFoundBody } from "./not-found-markdown";
import { suggestPages } from "./search-docs";

test("search results are in the HTML without a script", () => {
  const html = renderToStaticMarkup(SearchResults({ query: "OKM1101" }));
  expect(html).not.toContain("<script");
  expect(html).toContain('action="/search"');
  expect(html).toContain('name="q"');
  expect(html).toContain('href="/docs/reference/errors/OKM1101"');
  expect(html).toContain("OKM1101");
  expect(html).toContain("https://okm.omqkhafi.dev/docs/reference/errors/OKM1101.md");
});

test("the HTML 404 lists nearby pages", () => {
  const suggestions = suggestPages("/docs/schema/tabls");
  expect(suggestions.some((hit) => hit.url === "/docs/schema/tables")).toBe(true);
  const html = renderToStaticMarkup(NotFoundView({ path: "/docs/schema/tabls", suggestions }));
  expect(html).not.toContain("<script");
  expect(html).toContain("Not found");
  expect(html).toContain('href="/docs/schema/tables"');
  expect(html).toContain('href="/docs"');
  expect(html).toContain('href="/llms.txt"');
  const document = notFoundDocument("/docs/schema/tabls", suggestions);
  expect(document).toContain("<h1>Not found</h1>");
  expect(document).toContain('href="/docs/schema/tables"');
  expect(document).not.toContain("<script");
});

test("the markdown 404 names the closest page and is not a 200 body", () => {
  const body = markdownNotFoundBody("/docs/schema/tabls");
  expect(body.startsWith("# Not found")).toBe(true);
  expect(body).toContain("https://okm.omqkhafi.dev/llms.mdx/docs/schema/tables.md");
  expect(body).not.toContain("# Tables");
  const unknown = suggestPages("/docs/this-page-does-not-exist");
  expect(unknown.every((hit) => hit.url.startsWith("/docs"))).toBe(true);
});
