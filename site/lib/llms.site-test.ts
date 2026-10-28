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
  const urls = sitemap().map((entry) => entry.url);
  expect(urls).toContain(SITE_ORIGIN);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/start`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/start/why-okmodel`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/start/first-migration`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/concepts/how-okmodel-works`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/concepts/the-schema-is-the-catalog`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/concepts/type-safety-and-inference`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/concepts/migrations-and-drift`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/concepts/the-safety-model`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/concepts/tenant-isolation`);
  expect(urls).toContain(`${SITE_ORIGIN}/changelog`);
  expect(urls).toContain(`${SITE_ORIGIN}/llms.txt`);
  expect(urls).toContain(`${SITE_ORIGIN}/llms-full.txt`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/reference/cli`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/reference/compatibility`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/operate/production-checklist`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/operate/testing`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/operate/protected-targets-and-roles`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/migrations/checks-and-lint`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/migrations/backfill`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/migrations/failures`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/migrations/environments`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/queries`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/queries/read-rows`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/queries/write-rows`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/queries/shape-results`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/queries/search-and-trees`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/queries/transactions`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/queries/typed-raw-sql`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/queries/presets`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/queries/request-filters`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/schema/tables`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/schema/the-schema`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/schema/keys-and-identity`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/schema/validation`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/schema/names-and-casing`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/schema/traits`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/schema/tenancy`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/schema/codecs-and-row-types`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/schema/text-columns`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/schema/number-columns`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/schema/time-columns`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/schema/binary-json-id-columns`);
  expect(urls).toContain(`${SITE_ORIGIN}/docs/schema/postgres-specific-columns`);
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
    expect(urls.includes(`${SITE_ORIGIN}/docs/schema/${removed}`), removed).toBe(false);
  }
  expect(urls).toContain(`${SITE_ORIGIN}/docs/ai/skills`);

  expect(urls).toContain(`${SITE_ORIGIN}/.well-known/agent-skills/index.json`);

  const robotsTxt = buildRobotsTxt();
  expect(robotsTxt).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  expect(robotsTxt).toContain(`Host: ${SITE_ORIGIN}`);
  expect(robotsTxt).toContain("User-Agent: *");
  expect(robotsTxt).toContain("Content-Signal: search=yes, ai-input=yes, ai-train=yes");
  expect(robotsTxt).toContain("User-Agent: GPTBot\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: /");
});
