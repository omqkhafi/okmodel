/**
 * Fails when `README.md` contains a relative link or an image.
 *
 * npmjs.com renders the README from the published tarball. A relative link
 * or image does not resolve there.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

const IMAGE_INLINE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g;
const IMAGE_REF = /!\[[^\]]*\]\[([^\]]*)\]/g;
const LINK_INLINE = /(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g;
const REF_DEF = /^\[([^\]]+)\]:[ \t]*(\S+)/gm;
const HTML_IMAGE = /<img\b/gi;

/**
 * Reports relative links and images in a README.
 *
 * Code fences and inline code are ignored. A same-page `#` link is allowed.
 * `http://` and `https://` are allowed. Every image is a problem, including
 * one whose URL is absolute.
 *
 * @param markdown - README source
 * @param where - Path printed in each problem. Defaults to `README.md`
 * @returns Problem lines. Empty when the README is safe to publish
 */
export function checkReadme(markdown: string, where = "README.md"): readonly string[] {
  const prose = blankInlineCode(blankFences(markdown));
  const problems: string[] = [];
  for (const match of prose.matchAll(IMAGE_INLINE)) {
    problems.push(`${where} contains an image: ${match[1] ?? ""}`);
  }
  for (const match of prose.matchAll(IMAGE_REF)) {
    const id = match[1] ?? "";
    problems.push(`${where} contains an image: ${id.length === 0 ? "(reference)" : id}`);
  }
  for (const match of prose.matchAll(HTML_IMAGE)) {
    problems.push(`${where} contains an image: ${match[0] ?? "img"}`);
  }
  for (const match of prose.matchAll(LINK_INLINE)) {
    const url = match[1] ?? "";
    if (!isAllowedLink(url)) problems.push(`${where} contains a relative link: ${url}`);
  }
  for (const match of prose.matchAll(REF_DEF)) {
    const url = match[2] ?? "";
    if (isImageUrl(url)) {
      problems.push(`${where} contains an image: ${url}`);
      continue;
    }
    if (!isAllowedLink(url)) problems.push(`${where} contains a relative link: ${url}`);
  }
  return problems;
}

function isAllowedLink(url: string): boolean {
  if (url.startsWith("#")) return true;
  return /^https?:\/\//i.test(url);
}

function isImageUrl(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0] ?? url;
  return /\.(?:png|jpe?g|gif|webp|svg|avif|ico)$/i.test(path);
}

function blankFences(source: string): string {
  return source.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ""));
}

function blankInlineCode(source: string): string {
  return source.replace(/`[^`\n]+`/g, (span) => " ".repeat(span.length));
}

if (import.meta.main) {
  exitOnProblems(checkReadme(readFileSync(join(repoRoot(), "README.md"), "utf8")));
}
