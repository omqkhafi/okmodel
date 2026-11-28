/**
 * Schema groups, the task index, and the learning path.
 *
 * Moved pages keep their URLs. The task list is the module the page renders.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { POSTGRES_FEATURES } from "../src/tooling/capabilities/postgres.js";
import { FRONTMATTER_EXEMPT } from "../scripts/frontmatter-exempt.js";

const root = join(import.meta.dir, "..");
const docs = join(root, "site/content/docs");

const GROUPS = [
  "Tables and columns",
  "Types",
  "Keys and constraints",
  "Security",
  "Code in the database",
  "Packs",
  "Physical layout",
] as const;

test("schema has seven groups and none is empty", () => {
  const meta = JSON.parse(readFileSync(join(docs, "schema/meta.json"), "utf8")) as {
    pages: string[];
  };
  const names = meta.pages
    .filter((page) => page.startsWith("---"))
    .map((page) => page.slice(3, -3));
  expect(names).toEqual([...GROUPS]);
  for (let index = 0; index < meta.pages.length; index += 1) {
    const page = meta.pages[index];
    if (page === undefined || !page.startsWith("---")) continue;
    const next = meta.pages[index + 1];
    expect(next, page).toBeDefined();
    expect(next?.startsWith("---"), page).toBe(false);
  }
  const listed = new Set(meta.pages.filter((page) => !page.startsWith("---")));
  expect(listed.size).toBe(meta.pages.length - GROUPS.length);
});

test("the task page is generated from the task list and every target resolves", () => {
  const listed = spawnSync(
    "bun",
    [
      "-e",
      'import { DOCS_TASKS, renderTaskPage } from "./site/lib/tasks.ts"; const hrefs = DOCS_TASKS.map((item) => item.href); if (DOCS_TASKS.length !== 40) throw new Error(String(DOCS_TASKS.length)); process.stdout.write(JSON.stringify({ page: renderTaskPage(), hrefs }));',
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(listed.status, listed.stderr).toBe(0);
  const parsed = JSON.parse(listed.stdout) as { page: string; hrefs: string[] };
  expect(readFileSync(join(docs, "start/i-want-to.mdx"), "utf8")).toBe(parsed.page);
  expect(parsed.hrefs.length).toBe(40);
  for (const href of parsed.hrefs) expect(taskHrefResolves(href), href).toBe(true);
});

test("the learning path is on the docs home and in Get started", () => {
  for (const file of ["index.mdx", "start/index.mdx"]) {
    const text = readFileSync(join(docs, file), "utf8");
    expect(text, file).toContain("## Pick a path");
    expect(text, file).toContain("/docs/start/first-query");
    expect(text, file).toContain("/docs/start/first-schema");
    expect(text, file).toContain("/docs/start/first-migration");
    expect(text, file).toContain("/docs/start/production");
  }
});

test("retired URLs still redirect and the schema keys match their pages", () => {
  const redirected = spawnSync(
    "bun",
    [
      "-e",
      'import { resolveRedirect } from "./site/lib/docs-redirects.ts"; process.stdout.write(resolveRedirect("/docs/start/basic-usage") ?? "");',
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(redirected.status, redirected.stderr).toBe(0);
  expect(redirected.stdout).toBe("/docs/start/first-schema");
  const registry = new Set(Object.keys(POSTGRES_FEATURES));
  const pages = schemaFeaturePages();
  for (const [key, page] of Object.entries(pages)) {
    expect(registry.has(key), key).toBe(true);
    const text = readFileSync(join(docs, page), "utf8");
    const named =
      text.includes(`feature="${key}"`) ||
      text.includes(`feature: ${key}`) ||
      text.includes(`feature: "${key}"`);
    expect(named, `${key} on ${page}`).toBe(true);
  }
  for (const file of schemaPages()) {
    const text = outsideFences(readFileSync(file, "utf8"));
    const keys = new Set<string>();
    for (const match of text.matchAll(/^feature:\s*"?([A-Za-z0-9_.-]+)"?\s*$/gm)) {
      if (match[1] !== undefined) keys.add(match[1]);
    }
    for (const match of text.matchAll(/[{[][^}\n]*\bfeature="([^"]+)"[^}\n]*[}\]]/g)) {
      if (match[1] !== undefined) keys.add(match[1]);
    }
    for (const key of keys) {
      expect(registry.has(key), key).toBe(true);
      expect(pages[key], key).toBeDefined();
    }
  }
});

test("migrated pages do not type the support range", () => {
  const files = [
    join(docs, "index.mdx"),
    ...pagesIn("start"),
    ...pagesIn("concepts"),
    ...schemaPages(),
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    expect(text, file).not.toContain("tested on 15 to 19");
    expect(text, file).not.toContain("PostgreSQL 15 and later");
  }
  for (const path of FRONTMATTER_EXEMPT) {
    expect(path.startsWith("schema/"), path).toBe(false);
  }
});

/**
 * Schema key to the page that names it, read from the source file.
 */
function schemaFeaturePages(): Record<string, string> {
  const text = readFileSync(join(root, "site/lib/schema-features.ts"), "utf8");
  const pages: Record<string, string> = {};
  for (const match of text.matchAll(/"([^"]+)": "([^"]+)"/g)) {
    const key = match[1];
    const page = match[2];
    if (key !== undefined && page !== undefined) pages[key] = page;
  }
  return pages;
}

/**
 * Whether a task href is a handbook page, and an anchor when it has one.
 *
 * @param href - Absolute docs path
 */
function taskHrefResolves(href: string): boolean {
  const [rawPath, hash] = href.split("#", 2);
  if (rawPath === undefined || !rawPath.startsWith("/docs")) return false;
  const rest = rawPath.replace(/^\/docs\/?/, "");
  const base = rest.length === 0 ? docs : join(docs, rest);
  const file = [`${base}.mdx`, join(base, "index.mdx")].find((candidate) => {
    try {
      readFileSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
  if (file === undefined) return false;
  if (hash === undefined || hash.length === 0) return true;
  const body = readFileSync(file, "utf8");
  for (const match of body.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const title = (match[1] ?? "")
      .replace(/\s*\{#[^}]+\}\s*$/, "")
      .replace(/\s+(?:\[[^\]]*\]|\{[^}]*\})\s*$/, "")
      .trim();
    if (slugify(title) === hash.toLowerCase()) return true;
  }
  return false;
}

/**
 * Heading slug. Punctuation drops. Hyphens in the title stay.
 *
 * @param title - Heading text without a chip suffix
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Page body with fenced code blanked, so a sample cannot look like frontmatter.
 *
 * @param text - MDX source
 */
function outsideFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ""));
}

/**
 * Schema page paths.
 */
function schemaPages(): string[] {
  return pagesIn("schema");
}

/**
 * MDX files in one handbook folder.
 *
 * @param folder - Folder under `site/content/docs`
 */
function pagesIn(folder: string): string[] {
  return readdirSync(join(docs, folder))
    .filter((name) => name.endsWith(".mdx"))
    .map((name) => join(docs, folder, name));
}
