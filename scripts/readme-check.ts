/**
 * Fails when `README.md` contains a relative link or a relative image.
 *
 * npmjs.com renders the README from the published tarball. A relative link
 * or image does not resolve there. An absolute `https://` image does.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readmeConstantsBlock, readmeSupportTable } from "./docs-support.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

const CONSTANTS_OPEN = "<!-- docs-constants -->";
const CONSTANTS_CLOSE = "<!-- /docs-constants -->";
const SUPPORT_OPEN = "<!-- docs-support -->";
const SUPPORT_CLOSE = "<!-- /docs-support -->";

const IMAGE_INLINE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g;
const IMAGE_REF = /!\[[^\]]*\]\[([^\]]*)\]/g;
const LINK_INLINE = /(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g;
const REF_DEF = /^\[([^\]]+)\]:[ \t]*(\S+)/gm;
const HTML_SOURCE = /<(?:img|source)\b[^>]*>/gi;
const HTML_URL_ATTRIBUTE = /\b(?:src|srcset)\s*=\s*"([^"]*)"/gi;

/**
 * Reports relative links and images in a README.
 *
 * Code fences and inline code are ignored. A same-page `#` link is allowed.
 * `http://` and `https://` are allowed for links. An image must use an
 * absolute `https://` URL, in Markdown or in an `<img>` or `<source>` tag.
 *
 * @param markdown - README source
 * @param where - Path printed in each problem. Defaults to `README.md`
 * @returns Problem lines. Empty when the README is safe to publish
 */
export function checkReadme(markdown: string, where = "README.md"): readonly string[] {
  const prose = blankInlineCode(blankFences(markdown));
  const problems: string[] = [];
  for (const match of prose.matchAll(IMAGE_INLINE)) {
    const url = match[1] ?? "";
    if (!isAbsoluteImage(url)) problems.push(`${where} contains an image: ${url}`);
  }
  for (const match of prose.matchAll(IMAGE_REF)) {
    const id = match[1] ?? "";
    problems.push(`${where} contains an image: ${id.length === 0 ? "(reference)" : id}`);
  }
  for (const tag of prose.matchAll(HTML_SOURCE)) {
    const urls = [...tag[0].matchAll(HTML_URL_ATTRIBUTE)].map((attribute) => attribute[1] ?? "");
    if (urls.length === 0 || !urls.every(isAbsoluteImage)) {
      problems.push(`${where} contains an image: ${/^<\w+/.exec(tag[0])?.[0] ?? tag[0]}`);
    }
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

/**
 * Problems when the generated README blocks are missing or stale.
 *
 * Link and image checks stay in {@link checkReadme}. A snippet with no
 * markers is a problem only here, so a link fixture does not need the blocks.
 *
 * @param markdown - README source
 * @param where - Path printed in each problem
 * @returns Problem lines. Empty when both blocks match the generator
 */
export function checkReadmeSupport(markdown: string, where = "README.md"): readonly string[] {
  const problems: string[] = [];
  const constants = blockBetween(markdown, CONSTANTS_OPEN, CONSTANTS_CLOSE);
  const support = blockBetween(markdown, SUPPORT_OPEN, SUPPORT_CLOSE);
  if (constants === undefined) problems.push(`${where} is missing the docs-constants block`);
  else if (constants !== readmeConstantsBlock()) {
    problems.push(
      `${where} docs-constants block is stale. Run bun ./scripts/docs-support.ts --write`,
    );
  }
  if (support === undefined) problems.push(`${where} is missing the docs-support block`);
  else if (support !== readmeSupportTable()) {
    problems.push(
      `${where} docs-support block is stale. Run bun ./scripts/docs-support.ts --write`,
    );
  }
  return problems;
}

function blockBetween(markdown: string, open: string, close: string): string | undefined {
  const start = markdown.indexOf(open);
  if (start < 0) return undefined;
  const from = start + open.length;
  const end = markdown.indexOf(close, from);
  if (end < 0) return undefined;
  return markdown.slice(from, end).trim();
}

function isAllowedLink(url: string): boolean {
  if (url.startsWith("#")) return true;
  return /^https?:\/\//i.test(url);
}

function isAbsoluteImage(url: string): boolean {
  return /^https:\/\//i.test(url.trim());
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
  const markdown = readFileSync(join(repoRoot(), "README.md"), "utf8");
  exitOnProblems([...checkReadme(markdown), ...checkReadmeSupport(markdown)]);
}
