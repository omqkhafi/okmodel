/**
 * The handbook map matches `docs/`, and generated pages keep frontmatter,
 * resolved links, and a language on every fence.
 */

import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { mappedPages, pageContentPath, pageHref } from "../lib/docs-map";
import { contentDir, docMapProblems, fenceLanguages, markdownLinks, syncDocs } from "./sync-docs";

test("every docs file is mapped or excluded, and every mapped source exists", () => {
  expect(docMapProblems()).toEqual([]);
});

test("generated pages have frontmatter, resolved links, and fenced languages", () => {
  syncDocs();
  const hrefs = new Set(mappedPages.map((page) => pageHref(page)));

  for (const page of mappedPages) {
    const raw = readFileSync(join(contentDir, pageContentPath(page)), "utf8");
    expect(raw.startsWith("---\n")).toBe(true);
    const end = raw.indexOf("\n---\n");
    expect(end).toBeGreaterThan(0);
    const block = raw.slice(4, end);
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const split = line.indexOf(": ");
      expect(split).toBeGreaterThan(0);
      const key = line.slice(0, split);
      const value: unknown = JSON.parse(line.slice(split + 2));
      expect(typeof value).toBe("string");
      if (typeof value === "string") fields.set(key, value);
    }
    expect(fields.get("title")).toBe(page.title);
    expect(fields.get("description")).toBe(page.description);
    expect(fields.get("source")).toBe(page.source);

    const body = raw.slice(end + "\n---\n".length);
    for (const href of markdownLinks(body)) {
      const hash = href.indexOf("#");
      const path = hash < 0 ? href : href.slice(0, hash);
      if (path.startsWith("/docs")) {
        expect(hrefs.has(path), `${pageContentPath(page)} -> ${href}`).toBe(true);
      } else if (!path.startsWith("http") && !path.startsWith("mailto") && path.length > 0) {
        expect(path.endsWith(".md"), `${pageContentPath(page)} left ${href}`).toBe(false);
      }
    }
    for (const language of fenceLanguages(body)) {
      expect(language.length, pageContentPath(page)).toBeGreaterThan(0);
    }
  }

  const groups = new Set(
    readdirSync(contentDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  expect(groups.has("guides")).toBe(true);
  expect(groups.has("reference")).toBe(true);
});
