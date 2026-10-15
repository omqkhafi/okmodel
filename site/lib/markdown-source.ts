/**
 * On-disk docs source helpers — Copy Markdown / `.md` routes must return
 * byte-identical body text to the page files (frontmatter stripped).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { siteRoot } from "./repo";

/** Absolute path to `site/content/docs`. */
export const DOCS_CONTENT_DIR = join(siteRoot(), "content", "docs");

/**
 * Strip a leading YAML frontmatter block (`---` … `---`).
 *
 * @param raw - Full file contents
 * @returns Body after the closing `---` (leading blank line trimmed once)
 */
export function stripYamlFrontmatter(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return normalized;
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    return normalized;
  }
  return normalized.slice(end + "\n---\n".length).replace(/^\n/, "");
}

/**
 * Resolve the absolute path for a docs content-relative path.
 *
 * @param relativePath - e.g. `understand/the-architecture.md`
 */
export function docsContentPath(relativePath: string): string {
  return join(DOCS_CONTENT_DIR, relativePath);
}

/**
 * Read a docs page file and return the body with YAML frontmatter removed.
 *
 * @param relativePath - Path under `content/docs`
 */
export async function readDocsSourceBody(relativePath: string): Promise<string> {
  const raw = await readFile(docsContentPath(relativePath), "utf8");
  return stripYamlFrontmatter(raw);
}
