/**
 * llms.txt names every public page. Sitemap and robots use the same origin.
 */

import { expect, test } from "bun:test";

import { mappedPages, pageHref } from "./docs-map";
import { buildLlmsTxt, markdownPathForSlugs } from "./llms-index";
import { SITE_ORIGIN } from "./site-identity";
import robots from "../app/robots";
import sitemap from "../app/sitemap";

test("llms.txt lists every public page", () => {
  const text = buildLlmsTxt();
  for (const page of mappedPages) {
    const href = pageHref(page);
    const slugs = href === "/docs" ? [] : href.slice("/docs/".length).split("/");
    expect(text, page.title).toContain(markdownPathForSlugs(slugs));
    expect(text, page.title).toContain(page.title);
  }
});

test("sitemap and robots advertise the handbook", () => {
  const urls = sitemap().map((entry) => entry.url);
  expect(urls).toContain(SITE_ORIGIN);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/quickstart`);
  expect(urls).toContain(`${SITE_ORIGIN}/changelog`);
  expect(urls).toContain(`${SITE_ORIGIN}/llms.txt`);
  expect(urls).toContain(`${SITE_ORIGIN}/llms-full.txt`);
  expect(urls.some((url) => url.includes("/docs/reference/specification"))).toBe(true);

  const robotsDoc = robots();
  expect(robotsDoc.sitemap).toBe(`${SITE_ORIGIN}/sitemap.xml`);
  expect(robotsDoc.host).toBe(SITE_ORIGIN);
  const rules = robotsDoc.rules;
  const list = Array.isArray(rules) ? rules : [rules];
  expect(list.some((rule) => rule.userAgent === "*")).toBe(true);
});
