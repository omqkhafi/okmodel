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

test("sitemap and robots advertise the handbook", () => {
  const urls = sitemap().map((entry) => entry.url);
  expect(urls).toContain(SITE_ORIGIN);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/start`);
  expect(urls).toContain(`${SITE_ORIGIN}/changelog`);
  expect(urls).toContain(`${SITE_ORIGIN}/llms.txt`);
  expect(urls).toContain(`${SITE_ORIGIN}/llms-full.txt`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/reference/cli`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/ai/skills`);

  expect(urls).toContain(`${SITE_ORIGIN}/.well-known/agent-skills/index.json`);

  const robotsTxt = buildRobotsTxt();
  expect(robotsTxt).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  expect(robotsTxt).toContain(`Host: ${SITE_ORIGIN}`);
  expect(robotsTxt).toContain("User-Agent: *");
  expect(robotsTxt).toContain("Content-Signal: search=yes, ai-input=yes, ai-train=yes");
  expect(robotsTxt).toContain("User-Agent: GPTBot\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: /");
});
