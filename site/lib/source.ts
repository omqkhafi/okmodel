/**
 * Fumadocs loader for the generated handbook.
 */

import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/plugins/lucide-icons";

import { readDocsSourceBody } from "./markdown-source";

/** Docs base path. */
export const docsRoute = "/docs";

/** Per-page markdown route prefix. */
export const docsContentRoute = "/llms.mdx/docs";

/** Open Graph image route prefix. */
export const docsImageRoute = "/og/docs";

/** Loaded handbook. */
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

/**
 * Open Graph image URL for a docs page.
 *
 * @param page - Loaded page
 */
export function getPageImageUrl(page: (typeof source)["$inferPage"]): {
  segments: string[];
  url: string;
} {
  const segments = [...page.slugs, "image.png"];
  return {
    segments,
    url: `/${[...docsImageRoute.split("/"), ...segments].filter((part) => part.length > 0).join("/")}`,
  };
}

/**
 * Public markdown URL for a docs page. Always ends in `.md`.
 *
 * @param page - Loaded page
 */
export function getPageMarkdownUrl(page: (typeof source)["$inferPage"]): {
  segments: string[];
  url: string;
} {
  const last = page.slugs.at(-1);
  const segments =
    last !== undefined ? [...page.slugs.slice(0, -1), `${last}.md`] : ["index.md"];
  return {
    segments,
    url: `/${[...docsContentRoute.split("/"), ...segments].filter((part) => part.length > 0).join("/")}`,
  };
}

/**
 * Resolve a page from `/llms.mdx/docs/[[...slug]]`.
 * Accepts the slug, a trailing `content.md`, or a `.md` suffix.
 *
 * @param slug - Catch-all segments
 */
export function resolveMarkdownPage(
  slug: readonly string[] | undefined,
): (typeof source)["$inferPage"] | undefined {
  const parts = [...(slug ?? [])];
  const last = parts.at(-1);
  if (last === "content.md") {
    parts.pop();
  } else if (last?.endsWith(".md") === true) {
    const stem = last.slice(0, -".md".length);
    if (stem === "index" && parts.length === 1) {
      parts.pop();
    } else {
      parts[parts.length - 1] = stem;
    }
  }
  return source.getPage(parts.length > 0 ? [...parts] : undefined);
}

/**
 * Page markdown for agents: the generated body, with the title as the heading.
 *
 * @param page - Loaded page
 */
export async function getPageSourceMarkdown(
  page: (typeof source)["$inferPage"],
): Promise<string> {
  const body = await readDocsSourceBody(page.path);
  return `# ${page.data.title}\n\n${body.trim()}\n`;
}

/**
 * One page inside `llms-full.txt`.
 *
 * @param page - Loaded page
 */
export async function getLLMText(page: (typeof source)["$inferPage"]): Promise<string> {
  const body = await readDocsSourceBody(page.path);
  return `# ${page.data.title} (${page.url})\n\n${body.trim()}\n`;
}
