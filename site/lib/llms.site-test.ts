/**
 * llms.txt names every public page. Sitemap and robots use the same origin.
 */

import { expect, test } from "bun:test";

import { buildLlmsTxt, markdownPathForSlugs } from "./llms-index";
import { buildRobotsTxt } from "./robots-txt";
import { SITE_ORIGIN } from "./site-identity";
import { source } from "./source";
import sitemap from "../app/sitemap";

test("llms.txt lists every public page", () => {
  const text = buildLlmsTxt();
  const pages = source.getPages();
  expect(pages.length).toBeGreaterThan(0);
  for (const page of pages) {
    expect(text, page.url).toContain(`(${SITE_ORIGIN}${markdownPathForSlugs(page.slugs)})`);
  }
});

test("llms.txt lists each sidebar group once", () => {
  const text = buildLlmsTxt();
  const groups = source.getPageTree().children.flatMap((node) => {
    if (node.type !== "folder" || typeof node.name !== "string") return [];
    return [node.name];
  });
  expect(groups.length).toBeGreaterThan(0);
  expect(new Set(groups).size).toBe(groups.length);
  const headings = [...text.matchAll(/^## (.+)$/gm)].flatMap((match) => {
    const heading = match[1];
    return heading === undefined ? [] : [heading];
  });
  const groupHeadings = headings.filter((heading) => groups.includes(heading));
  expect(groupHeadings).toEqual(groups);
});

test("sitemap and robots advertise the handbook", () => {
  const urls = new Set(sitemap().map((entry) => entry.url));
  expect(urls.has(SITE_ORIGIN)).toBe(true);
  expect(urls.has(`${SITE_ORIGIN}/changelog`)).toBe(true);
  expect(urls.has(`${SITE_ORIGIN}/llms.txt`)).toBe(true);
  expect(urls.has(`${SITE_ORIGIN}/llms-full.txt`)).toBe(true);
  for (const page of source.getPages()) {
    expect(urls.has(`${SITE_ORIGIN}${page.url}`), page.url).toBe(true);
  }
  for (const removed of [
    "validation-schema",
    "traits-schema",
    "tenancy-schema",
    "casing",
    "codecs",
    "row-types",
    "the-schema-tables",
    "min-postgres",
    "id-default",
    "id-generators",
  ]) {
    expect(urls.has(`${SITE_ORIGIN}/docs/schema/${removed}`), removed).toBe(false);
  }

  expect(urls.has(`${SITE_ORIGIN}/.well-known/agent-skills/index.json`)).toBe(true);

  const robotsTxt = buildRobotsTxt();
  expect(robotsTxt).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  expect(robotsTxt).toContain(`Host: ${SITE_ORIGIN}`);
  expect(robotsTxt).toContain("User-Agent: *");
  expect(robotsTxt).toContain("Content-Signal: search=yes, ai-input=yes, ai-train=yes");
  expect(robotsTxt).toContain("User-Agent: GPTBot\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: /");
});
