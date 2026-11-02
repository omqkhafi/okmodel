/**
 * Writes `lib/handbook-paths.json`: every handbook page URL. The proxy reads
 * that bundled list at request time instead of walking `content/docs`.
 * `lib/handbook-pages.site-test.ts` fails when the file is behind.
 *
 *   bun ./site/scripts/handbook-paths.ts --write
 */

import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SITE_DIR } from "./request-time";

const CONTENT_DIR = join(SITE_DIR, "content", "docs");

/** Path of the generated list. */
export const HANDBOOK_PATHS_FILE = join(SITE_DIR, "lib", "handbook-paths.json");

/** Sorted handbook page URLs from the `.mdx` / `.md` files in `content/docs`. */
export function handbookPaths(): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(CONTENT_DIR, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.mdx?$/.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name).slice(CONTENT_DIR.length + 1);
    const slug = file.replace(/\.mdx?$/, "").replace(/(?:^|\/)index$/, "");
    paths.push(slug.length === 0 ? "/docs" : `/docs/${slug}`);
  }
  return paths.sort();
}

/** File contents for {@link HANDBOOK_PATHS_FILE}. */
export function renderHandbookPaths(): string {
  return `${JSON.stringify(handbookPaths(), null, 2)}\n`;
}

if (import.meta.main) {
  if (!process.argv.includes("--write")) {
    console.error("Pass --write to regenerate lib/handbook-paths.json.");
    process.exit(1);
  }
  writeFileSync(HANDBOOK_PATHS_FILE, renderHandbookPaths());
  console.log(`handbook-paths: wrote ${String(handbookPaths().length)} paths`);
}
