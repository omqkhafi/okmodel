/**
 * llms.txt names every public page. Sitemap and robots use the same origin.
 */

import { expect, test } from "bun:test";

import { buildLlmsTxt, markdownPathForSlugs } from "./llms-index";
import { SITE_ORIGIN } from "./site-identity";
import { source } from "./source";
import robots from "../app/robots";
import sitemap from "../app/sitemap";

test("llms.txt lists every public page", () => {
  const text = buildLlmsTxt();
  const pages = source.getPages();
  expect(pages.length).toBeGreaterThan(0);
  for (const page of pages) {
    expect(text, page.url).toContain(`(${SITE_ORIGIN}${markdownPathForSlugs(page.slugs)})`);
  }
});

test("sitemap and robots advertise the handbook", () => {
  const urls = sitemap().map((entry) => entry.url);
  expect(urls).toContain(SITE_ORIGIN);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/start`);
  expect(urls).toContain(`${SITE_ORIGIN}/changelog`);
  expect(urls).toContain(`${SITE_ORIGIN}/llms.txt`);
  expect(urls).toContain(`${SITE_ORIGIN}/llms-full.txt`);
  expect(urls.some((url) => url.includes("/docs/reference/"))).toBe(false);

  const robotsDoc = robots();
  expect(robotsDoc.sitemap).toBe(`${SITE_ORIGIN}/sitemap.xml`);
  expect(robotsDoc.host).toBe(SITE_ORIGIN);
  const rules = robotsDoc.rules;
  const list = Array.isArray(rules) ? rules : [rules];
  expect(list.some((rule) => rule.userAgent === "*")).toBe(true);
});
