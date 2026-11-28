/**
 * Handbook pages as the compiled source already holds them.
 *
 * Request-time search reads this module. It does not import `node:fs` or
 * `lib/repo.ts`. Processed markdown is the `_markdown` export from
 * `includeProcessedMarkdown`.
 */

import type { ReactNode } from "react";

import { FEATURE_RULES } from "./generated/feature-rules";
import { orderedHandbookUrls } from "./page-chrome";
import { source } from "./source";

/** One handbook page the search index and the agent generator share. */
export type HandbookPage = {
  readonly path: string;
  readonly url: string;
  readonly slugs: readonly string[];
  readonly title: string;
  readonly description: string;
  readonly summary: string;
  readonly feature: string;
  readonly chip: string;
  /** Top-level sidebar section, such as `Schema`. */
  readonly section: string;
  /** Folder slug, such as `schema`. Root pages use `handbook`. */
  readonly sectionSlug: string;
  /** Processed markdown body. Frontmatter is already removed. */
  readonly body: string;
  readonly headings: readonly string[];
  readonly functions: readonly string[];
  readonly options: readonly string[];
  readonly codes: readonly string[];
};

type LoadedPage = ReturnType<typeof source.getPages>[number];

let cached: readonly HandbookPage[] | undefined;

/**
 * Every handbook page, in sidebar order.
 */
export function handbookPages(): readonly HandbookPage[] {
  cached ??= loadPages();
  return cached;
}

/**
 * One page by its HTML path.
 *
 * @param url - Handbook path, such as `/docs/schema/tables`
 */
export function handbookPage(url: string): HandbookPage | undefined {
  return handbookPages().find((page) => page.url === url);
}

/**
 * Build the page list from the compiled source.
 */
function loadPages(): readonly HandbookPage[] {
  const loaded = source.getPages();
  const byUrl = new Map(loaded.map((page) => [page.url, page]));
  const sections = sectionByUrl();
  const ordered = orderedHandbookUrls();
  const seen = new Set<string>();
  const pages: HandbookPage[] = [];
  for (const url of ordered) {
    const page = byUrl.get(url);
    if (page === undefined) continue;
    seen.add(url);
    pages.push(toHandbookPage(page, sections.get(url)));
  }
  for (const page of loaded) {
    if (seen.has(page.url)) continue;
    pages.push(toHandbookPage(page, sections.get(page.url)));
  }
  return pages;
}

/**
 * Map each page URL to its top-level section. The slug is the first path
 * segment (`start`, `schema`), which is also the agent file name.
 */
function sectionByUrl(): Map<string, { readonly name: string; readonly slug: string }> {
  const map = new Map<string, { readonly name: string; readonly slug: string }>();
  const tree = source.getPageTree();
  const visit = (nodes: readonly PageNode[], section: { readonly name: string; readonly slug: string } | undefined): void => {
    for (const node of nodes) {
      if (node.type === "page" && typeof node.url === "string") {
        map.set(node.url, section ?? sectionFromUrl(node.url));
      } else if (node.type === "folder") {
        const slug = section?.slug ?? folderSlug(node);
        const name = section?.name ?? (typeof node.name === "string" ? node.name : slug);
        const next = { name, slug };
        if (node.index !== undefined && typeof node.index.url === "string") map.set(node.index.url, next);
        visit(node.children ?? [], next);
      }
    }
  };
  visit(tree.children as readonly PageNode[], undefined);
  return map;
}

type PageNode = {
  readonly type: string;
  readonly url?: string;
  readonly name?: ReactNode;
  readonly index?: { readonly url?: string };
  readonly children?: readonly PageNode[];
};

/**
 * First `/docs` segment for a folder, from its index or its first child URL.
 *
 * @param node - Folder node
 */
function folderSlug(node: PageNode): string {
  const indexUrl = node.index?.url;
  if (typeof indexUrl === "string") {
    const slug = sectionFromUrl(indexUrl).slug;
    if (slug !== "handbook") return slug;
  }
  for (const child of node.children ?? []) {
    const url = child.type === "page" ? child.url : child.index?.url;
    if (typeof url !== "string") continue;
    const slug = sectionFromUrl(url).slug;
    if (slug !== "handbook") return slug;
  }
  return "handbook";
}

/**
 * Section slug from a handbook URL.
 *
 * @param url - Page path
 */
function sectionFromUrl(url: string): { readonly name: string; readonly slug: string } {
  if (!url.startsWith("/docs/")) return { name: "Handbook", slug: "handbook" };
  const slug = url.slice("/docs/".length).split("/")[0] ?? "";
  if (slug.length === 0) return { name: "Handbook", slug: "handbook" };
  return { name: slug, slug };
}

/**
 * Copy one loaded page into the shared record.
 *
 * @param page - Compiled page
 * @param section - Top-level section, when the tree named one
 */
function toHandbookPage(
  page: LoadedPage,
  section: { readonly name: string; readonly slug: string } | undefined,
): HandbookPage {
  const data = page.data as {
    readonly title?: unknown;
    readonly description?: unknown;
    readonly summary?: unknown;
    readonly feature?: unknown;
    readonly structuredData?: unknown;
    readonly _exports?: unknown;
  };
  const title = text(data.title) || page.path;
  const description = text(data.description);
  const summary = text(data.summary) || description;
  const feature = text(data.feature);
  const body = processedBody(page.url, data._exports);
  const headings = headingTexts(data.structuredData);
  return {
    path: page.path,
    url: page.url,
    slugs: page.slugs,
    title,
    description,
    summary,
    feature,
    chip: chipLine(feature),
    section: section?.name ?? "Handbook",
    sectionSlug: section?.slug ?? "handbook",
    body,
    headings,
    functions: functionNames(body),
    options: optionNames(body),
    codes: errorCodes(body),
  };
}

/**
 * Processed markdown exported by the MDX collection.
 *
 * @param url - Page URL, for the error when the export is missing
 * @param exported - Compiled module namespace
 */
function processedBody(url: string, exported: unknown): string {
  if (typeof exported === "object" && exported !== null && "_markdown" in exported) {
    const markdown = exported._markdown;
    if (typeof markdown === "string") return markdown.replace(/\r\n/g, "\n");
  }
  throw new Error(`processed markdown missing for ${url}`);
}

/**
 * Support chip line for a page-level `feature` key.
 *
 * @param feature - Frontmatter feature key
 */
function chipLine(feature: string): string {
  if (feature.length === 0) return "";
  return FEATURE_RULES[feature]?.line ?? "";
}

/**
 * Heading text from fumadocs structured data.
 *
 * @param structured - `structuredData` export
 */
function headingTexts(structured: unknown): string[] {
  if (typeof structured !== "object" || structured === null || !("headings" in structured)) return [];
  const headings = structured.headings;
  if (!Array.isArray(headings)) return [];
  const texts: string[] = [];
  for (const heading of headings) {
    if (typeof heading !== "object" || heading === null || !("content" in heading)) continue;
    const content = heading.content;
    if (typeof content === "string" && content.trim().length > 0) texts.push(content.trim());
  }
  return texts;
}

/**
 * Public function names: exports and backtick calls.
 *
 * @param body - Processed markdown
 */
function functionNames(body: string): string[] {
  const names = new Set<string>();
  for (const match of body.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  for (const match of body.matchAll(/export\s+(?:async\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  for (const match of body.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)\(\)`/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

/**
 * Option names from each `Options` section.
 *
 * @param body - Processed markdown
 */
function optionNames(body: string): string[] {
  const names = new Set<string>();
  for (const part of body.split(/^## /m)) {
    if (!/^options\b/i.test(part)) continue;
    const section = part.split(/^## /)[0] ?? part;
    for (const match of section.matchAll(/`([A-Za-z_][\w.]*)`/g)) {
      const name = match[1];
      if (name !== undefined && name.length > 1 && name.length < 48) names.add(name);
    }
  }
  return [...names];
}

/**
 * OKM codes mentioned on the page.
 *
 * @param body - Processed markdown
 */
function errorCodes(body: string): string[] {
  return [...new Set([...body.matchAll(/\bOKM\d{4}\b/g)].map((match) => match[0] ?? ""))].filter(
    (code) => code.length > 0,
  );
}

/**
 * Frontmatter string, or empty.
 *
 * @param value - Compiled frontmatter field
 */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
