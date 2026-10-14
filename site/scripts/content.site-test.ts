/**
 * Handbook pages keep a title and description, a language on every fence,
 * `/docs` links that resolve, and a `meta.json` entry in their folder.
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { DOCS_CONTENT_DIR as contentDir } from "../lib/markdown-source";
import { markdownFiles } from "./docs-code";

const pages = markdownFiles(contentDir);

test("every page has a title and a description", () => {
  expect(pages.length).toBeGreaterThan(0);
  for (const file of pages) {
    const raw = readFileSync(file, "utf8");
    const end = raw.indexOf("\n---\n");
    const where = relative(contentDir, file);
    expect(raw.startsWith("---\n") && end > 0, where).toBe(true);
    const block = raw.slice(4, end);
    expect(block, where).toMatch(/^title: \S/m);
    expect(block, where).toMatch(/^description: \S/m);
  }
});

test("every fence has a language and every /docs link resolves", () => {
  for (const file of pages) {
    const where = relative(contentDir, file);
    const lines = readFileSync(file, "utf8").split("\n");
    const prose: string[] = [];
    let open = false;
    for (const line of lines) {
      if (line.startsWith("```")) {
        if (!open) expect(line.slice(3).trim().length, where).toBeGreaterThan(0);
        open = !open;
        continue;
      }
      if (!open) prose.push(line);
    }
    for (const match of prose.join("\n").matchAll(/\]\((\/docs[^)\s#]*)/g)) {
      const href = match[1] ?? "";
      expect(pageExists(href), `${where} -> ${href}`).toBe(true);
    }
  }
});

test("every page and folder is listed in its meta.json", () => {
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isDirectory() || /\.mdx?$/.test(entry.name))
      .map((entry) => entry.name.replace(/\.mdx?$/, ""));
    const meta: unknown = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    const listed =
      typeof meta === "object" && meta !== null && "pages" in meta && Array.isArray(meta.pages)
        ? meta.pages.filter((item): item is string => typeof item === "string" && !item.startsWith("---"))
        : [];
    const where = relative(contentDir, dir) || ".";
    expect(listed.slice().sort(), where).toEqual(names.slice().sort());
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
    }
  };
  walk(contentDir);
});

function pageExists(href: string): boolean {
  const rest = href.replace(/^\/docs\/?/, "").replace(/\/$/, "");
  const base = rest.length === 0 ? contentDir : join(contentDir, rest);
  return [`${base}.mdx`, `${base}.md`, join(base, "index.mdx"), join(base, "index.md")].some((path) =>
    existsSync(path),
  );
}
