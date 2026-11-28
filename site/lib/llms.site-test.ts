/**
 * llms.txt names every public page. Sitemap and robots use the same origin.
 * The full dump is gone.
 */

import { expect, test } from "bun:test";

import sitemap from "../app/sitemap";
import { agentFiles, buildLlmsTxt } from "./agent-docs";
import { markdownPathForSlugs } from "./markdown-url";
import { buildRobotsTxt } from "./robots-txt";
import { SITE_ORIGIN } from "./site-identity";
import { source } from "./source";

test("llms.txt lists every public page", () => {
  const text = buildLlmsTxt();
  const pages = source.getPages();
  expect(pages.length).toBeGreaterThan(0);
  for (const page of pages) {
    expect(text, page.url).toContain(`(${SITE_ORIGIN}${markdownPathForSlugs(page.slugs)})`);
  }
  expect(text).not.toContain("llms-full.txt");
});

test("every llms.txt link is a page, an agent file, or an external url", () => {
  const files = new Set(agentFiles().map((file) => `/${file.name}`));
  const pages = new Set(source.getPages().map((page) => markdownPathForSlugs(page.slugs)));
  const links = [...buildLlmsTxt().matchAll(/\]\(([^)]+)\)/g)].flatMap((match) => {
    const href = match[1];
    return href === undefined ? [] : [href];
  });
  expect(links.length).toBeGreaterThan(100);
  for (const href of links) {
    const url = new URL(href);
    if (url.origin !== SITE_ORIGIN) continue;
    const known = pages.has(url.pathname) || files.has(url.pathname) || url.pathname === "/changelog";
    expect(known, href).toBe(true);
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
  expect(headings).toContain("Optional");
});

test("sitemap and robots advertise the handbook", () => {
  const urls = new Set(sitemap().map((entry) => entry.url));
  expect(urls.has(SITE_ORIGIN)).toBe(true);
  expect(urls.has(`${SITE_ORIGIN}/changelog`)).toBe(true);
  expect(urls.has(`${SITE_ORIGIN}/llms.txt`)).toBe(true);
  expect(urls.has(`${SITE_ORIGIN}/llms-full.txt`)).toBe(false);
  expect(urls.has(`${SITE_ORIGIN}/llms-core-1.txt`) || urls.has(`${SITE_ORIGIN}/llms-core.txt`)).toBe(true);
  for (const file of agentFiles()) {
    expect(urls.has(`${SITE_ORIGIN}/${file.name}`), file.name).toBe(true);
  }
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

test("robots.txt does not disallow docs, markdown, or llms files", () => {
  const robotsTxt = buildRobotsTxt();
  expect(robotsTxt).not.toMatch(/^Disallow:/m);
  for (const agent of ["*", "GPTBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended"]) {
    expect(robotsTxt).toContain(`User-Agent: ${agent}\n`);
  }
  expect(robotsTxt).not.toContain("Disallow: /docs");
  expect(robotsTxt).not.toContain("Disallow: /llms");
  expect(robotsTxt).not.toContain(".md");
  const groups = robotsTxt.split(/\n\n+/);
  for (const group of groups) {
    if (!group.startsWith("User-Agent:")) continue;
    expect(group, group).toContain("Allow: /");
    expect(group, group).not.toContain("Disallow:");
  }
});
