/**
 * `/llms.txt` index. Every public handbook page is listed.
 */

import type * as PageTree from "fumadocs-core/page-tree";

import { readRootPackage, readTagline, siteSameAs } from "./package-meta";
import { SITE_NAME, SITE_ORIGIN } from "./site-identity";
import { source } from "./source";

/** One handbook page as the index sees it. */
export interface LlmsPageRef {
  readonly slugs: readonly string[];
  readonly url: string;
  readonly title: string;
  readonly description: string;
}

/**
 * Absolute URL on the site origin. `http(s)` values pass through.
 *
 * @param path - Site path beginning with `/`, or an absolute URL
 * @param origin - Override for tests
 */
export function absoluteDocsUrl(path: string, origin: string = SITE_ORIGIN): string {
  if (path.startsWith("https://") || path.startsWith("http://")) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${origin.replace(/\/$/, "")}${normalized}`;
}

/**
 * Per-page markdown path.
 *
 * @param slugs - Docs slug segments. Empty is the introduction.
 */
export function markdownPathForSlugs(slugs: readonly string[]): string {
  if (slugs.length === 0) return "/llms.mdx/docs/index.md";
  const last = slugs.at(-1);
  if (last === undefined) return "/llms.mdx/docs/index.md";
  const head = slugs.slice(0, -1);
  return head.length > 0
    ? `/llms.mdx/docs/${head.join("/")}/${last}.md`
    : `/llms.mdx/docs/${last}.md`;
}

/**
 * Handbook pages from the live source, in source order.
 */
export function listLlmsPages(): LlmsPageRef[] {
  return source.getPages().map((page) => ({
    slugs: page.slugs,
    url: page.url,
    title: page.data.title,
    description: typeof page.data.description === "string" ? page.data.description : "",
  }));
}

/**
 * llmstxt.org index in sidebar order. Root pages come first, then one
 * heading per top-level folder with every page under it.
 *
 * @param origin - Absolute origin
 * @param pages - Handbook pages. Defaults to the live source.
 * @param tree - Sidebar tree. Defaults to the live source.
 */
export function buildLlmsTxt(
  origin: string = SITE_ORIGIN,
  pages: readonly LlmsPageRef[] = listLlmsPages(),
  tree: PageTree.Root = source.getPageTree(),
): string {
  const byUrl = new Map(pages.map((page) => [page.url, page]));
  const lines: string[] = [
    `# ${SITE_NAME}`,
    "",
    `> ${readTagline()}`,
    "",
    "Fetch `/llms.mdx/docs/⟨slug⟩.md` for one page as markdown, or `/llms-full.txt` for every page.",
    "",
  ];

  const rootUrls: string[] = [];
  const folders: PageTree.Folder[] = [];
  for (const node of tree.children) {
    if (node.type === "page") rootUrls.push(node.url);
    else if (node.type === "folder") folders.push(node);
  }
  lines.push("## Start", "");
  pushPages(lines, rootUrls, byUrl, origin);
  lines.push("");

  for (const folder of folders) {
    lines.push(`## ${typeof folder.name === "string" ? folder.name : ""}`, "");
    pushPages(lines, folderUrls(folder), byUrl, origin);
    lines.push("");
  }

  lines.push("## Also", "");
  lines.push(linkLine("Changelog", absoluteDocsUrl("/changelog", origin), "Published releases."));
  lines.push(linkLine("llms-full.txt", absoluteDocsUrl("/llms-full.txt", origin), "Every page."));
  for (const url of siteSameAs()) {
    const title = url.includes("github.com") ? "GitHub" : readRootPackage().name;
    lines.push(linkLine(title, url, ""));
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * JSON catalogue of the same pages.
 *
 * @param origin - Absolute origin
 * @param pages - Handbook pages
 */
export function buildLlmsCatalog(
  origin: string = SITE_ORIGIN,
  pages: readonly LlmsPageRef[] = listLlmsPages(),
): {
  readonly name: string;
  readonly description: string;
  readonly origin: string;
  readonly index: string;
  readonly full: string;
  readonly pages: readonly {
    readonly slug: string;
    readonly title: string;
    readonly description: string;
    readonly html: string;
    readonly markdown: string;
  }[];
} {
  const sorted = pages.slice().sort((a, b) => a.url.localeCompare(b.url));
  return {
    name: SITE_NAME,
    description: readTagline(),
    origin,
    index: absoluteDocsUrl("/llms.txt", origin),
    full: absoluteDocsUrl("/llms-full.txt", origin),
    pages: sorted.map((page) => ({
      slug: page.slugs.join("/"),
      title: page.title,
      description: page.description,
      html: absoluteDocsUrl(page.url, origin),
      markdown: absoluteDocsUrl(markdownPathForSlugs(page.slugs), origin),
    })),
  };
}

/**
 * Page URLs under one folder in sidebar order: the folder index, then each
 * child, nested folders included.
 *
 * @param folder - Sidebar folder
 */
function folderUrls(folder: PageTree.Folder): string[] {
  const urls = folder.index === undefined ? [] : [folder.index.url];
  for (const node of folder.children) {
    if (node.type === "page") urls.push(node.url);
    else if (node.type === "folder") urls.push(...folderUrls(node));
  }
  return urls;
}

function pushPages(
  lines: string[],
  urls: readonly string[],
  byUrl: ReadonlyMap<string, LlmsPageRef>,
  origin: string,
): void {
  for (const url of urls) {
    const page = byUrl.get(url);
    if (page === undefined) continue;
    lines.push(linkLine(page.title, absoluteDocsUrl(markdownPathForSlugs(page.slugs), origin), page.description));
  }
}

function linkLine(title: string, href: string, note: string): string {
  return note.length > 0 ? `- [${title}](${href}): ${note}` : `- [${title}](${href})`;
}
