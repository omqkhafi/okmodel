/**
 * Docs URLs shipped in README.md, `src/`, and `docs/` must resolve to a
 * handbook page or an anchor on that page.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { DOCS_CONTENT_DIR } from "./markdown-source";
import { repoRoot } from "./repo";

/** One docs URL found in repository text. */
export type DocsUrlHit = {
  readonly href: string;
  readonly file: string;
};

const DOCS_HREF =
  /https:\/\/okm\.omqkhafi\.dev(\/docs[^)\s"'`]*)|\]\((\/docs[^)\s"'`)]*)|(?:^|[\s"'`(=])(\/docs\/[A-Za-z0-9_./#-]+)/g;

/**
 * Collect `/docs…` URLs from README.md, `src/`, and `docs/`.
 */
export function collectShippedDocsUrls(): readonly DocsUrlHit[] {
  const root = repoRoot();
  const hits: DocsUrlHit[] = [];
  const files = [
    join(root, "README.md"),
    ...walkFiles(join(root, "src"), (name) => name.endsWith(".ts") || name.endsWith(".md")),
    ...walkFiles(join(root, "docs"), (name) => name.endsWith(".md")),
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(DOCS_HREF)) {
      const href = match[1] ?? match[2] ?? match[3];
      if (href === undefined || href.length === 0) continue;
      hits.push({ href, file: relative(root, file) });
    }
  }
  return hits;
}

/**
 * Whether a docs href resolves to a page or an anchor on that page.
 *
 * @param href - Absolute `/docs…` path, optional `#anchor`
 */
export function docsUrlResolves(href: string): boolean {
  const [rawPath, hash] = href.split("#", 2);
  if (rawPath === undefined) return false;
  const path = rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  return pageOrAnchorExists(path, hash);
}

/**
 * Whether the handbook has this page, and the anchor when one is named.
 *
 * @param path - `/docs` or `/docs/…`
 * @param hash - Anchor without `#`, or undefined
 */
function pageOrAnchorExists(path: string, hash: string | undefined): boolean {
  const file = handbookFile(path);
  if (file === undefined) return false;
  if (hash === undefined || hash.length === 0) return true;
  const body = readFileSync(file, "utf8");
  const needle = hash.toLowerCase();
  if (body.includes(`id="${needle}"`) || body.includes(`id='${needle}'`)) return true;
  if (body.includes(`{#${needle}}`) || body.includes(`{#${hash}}`)) return true;
  // Fumadocs slugifies headings; accept an H2/H3 whose slug matches.
  for (const match of body.matchAll(/^#{2,3}\s+(.+)$/gm)) {
    const title = match[1]?.replace(/\s*\{#[^}]+\}\s*$/, "").trim() ?? "";
    if (slugify(title) === needle) return true;
  }
  return false;
}

/**
 * On-disk handbook file for a docs path.
 *
 * @param path - `/docs` or `/docs/…`
 */
function handbookFile(path: string): string | undefined {
  const rest = path.replace(/^\/docs\/?/, "").replace(/\/$/, "");
  const base = rest.length === 0 ? DOCS_CONTENT_DIR : join(DOCS_CONTENT_DIR, rest);
  const candidates = [`${base}.mdx`, `${base}.md`, join(base, "index.mdx"), join(base, "index.md")];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Rough heading slug used by the handbook (lowercase, hyphenated).
 *
 * @param title - Heading text
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Walk a directory for matching files.
 *
 * @param dir - Absolute directory
 * @param keep - File-name predicate
 */
function walkFiles(dir: string, keep: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walkFiles(full, keep));
    else if (keep(entry)) out.push(full);
  }
  return out;
}
