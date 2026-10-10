/**
 * Generate `site/content/docs` from the checked-in map.
 * The handbook is not copied by hand. Run this on postinstall, dev, and build.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { posix } from "node:path";

import {
  docGroups,
  excludedDocs,
  mappedPages,
  pageContentPath,
  pageHref,
  type MappedPage,
} from "../lib/docs-map";
import { extractReadmeH2, readRootPackage } from "../lib/package-meta";
import { repoRoot, siteRoot } from "../lib/repo";
import { githubBlobUrl } from "../lib/shared";

/** Where generated markdown and `meta.json` files are written. */
export const contentDir = join(siteRoot(), "content", "docs");

/**
 * Problems in the map: a missing source, an unmapped `docs/` file, or a file
 * that is both published and excluded.
 */
export function docMapProblems(): readonly string[] {
  const problems: string[] = [];
  const root = repoRoot();
  const docsDir = join(root, "docs");
  const mappedSources = new Set(mappedPages.map((page) => page.source));
  const excluded = new Set(excludedDocs.map((item) => item.path));

  for (const path of excluded) {
    if (mappedSources.has(path)) {
      problems.push(`${path} is both a handbook page and an exclusion`);
    }
    if (!existsSync(join(root, path))) {
      problems.push(`excluded file is missing: ${path}`);
    }
    const reason = excludedDocs.find((item) => item.path === path)?.reason ?? "";
    if (reason.trim().length === 0) problems.push(`exclusion ${path} has no reason`);
  }

  for (const file of markdownFiles(docsDir)) {
    const rel = posix.join("docs", posix.relative(docsDir, file));
    if (!mappedSources.has(rel) && !excluded.has(rel)) {
      problems.push(`${rel} is not mapped and not excluded`);
    }
  }

  const seen = new Set<string>();
  for (const page of mappedPages) {
    const key = `${page.group}/${page.slug}`;
    if (seen.has(key)) problems.push(`duplicate slug ${key}`);
    seen.add(key);
    if (page.title.trim().length === 0) problems.push(`${key} has no title`);
    if (page.description.trim().length === 0) problems.push(`${key} has no description`);
    if (!existsSync(join(root, page.source))) {
      problems.push(`mapped source is missing: ${page.source} (${key})`);
    }
    if (page.readmeSection !== undefined && page.readmeIntro === true) {
      problems.push(`${key} cannot be both a README section and the introduction`);
    }
  }

  const readme = readFileSync(join(root, "README.md"), "utf8");
  for (const page of mappedPages) {
    if (page.readmeSection === undefined) continue;
    if (!readme.includes(`\n## ${page.readmeSection}\n`) && !readme.startsWith(`## ${page.readmeSection}\n`)) {
      problems.push(`README is missing ## ${page.readmeSection}`);
    }
  }

  for (const group of docGroups) {
    if (!mappedPages.some((page) => page.group === group.id)) {
      problems.push(`group ${group.id} has no pages`);
    }
  }

  return problems;
}

/** Result of one sync. */
export interface SyncResult {
  /** Bare fences labeled `text` so every fence has a language. */
  readonly bareFences: number;
  /** TypeScript fences in guide pages that did not come from `readme-examples.md`. */
  readonly unsplicedTypeFences: readonly string[];
}

/**
 * Rewrite `content/docs` from the map. Throws when {@link docMapProblems} is not empty.
 */
export function syncDocs(): SyncResult {
  const problems = docMapProblems();
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }

  const root = repoRoot();
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const samples = parseSamples(readFileSync(join(root, "docs/readme-examples.md"), "utf8"));
  const sampleFences = new Set(samples.values());
  let bareFences = 0;
  const unsplicedTypeFences: string[] = [];

  rmSync(contentDir, { recursive: true, force: true });
  mkdirSync(contentDir, { recursive: true });

  for (const page of mappedPages) {
    let body = pageBody(page, readme, root);
    if (page.readmeSection !== undefined) {
      body = spliceSamples(body, samples);
    }
    const labeled = labelBareFences(body);
    bareFences += labeled.count;
    body = rewriteDocLinks(labeled.text, page.source);
    const rel = pageContentPath(page);
    noteUnspliced(rel, body, sampleFences, unsplicedTypeFences);
    const file = join(contentDir, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `${frontmatter(page)}${body.trim()}\n`);
  }

  writeMeta();
  return { bareFences, unsplicedTypeFences };
}

/**
 * Markdown links outside fenced code.
 *
 * @param markdown - Page body
 */
export function markdownLinks(markdown: string): readonly string[] {
  const masked = maskFences(markdown).text;
  const hrefs: string[] = [];
  for (const match of masked.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const href = match[1];
    if (href !== undefined) hrefs.push(href);
  }
  return hrefs;
}

/**
 * Opening fence languages outside nested concerns. Empty when a fence has no language.
 *
 * @param markdown - Page body
 */
export function fenceLanguages(markdown: string): readonly string[] {
  const languages: string[] = [];
  let open = false;
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("```")) continue;
    if (!open) {
      open = true;
      languages.push(line.slice(3).trim().split(/\s+/)[0] ?? "");
    } else {
      open = false;
    }
  }
  return languages;
}

if (import.meta.main) {
  try {
    const result = syncDocs();
    process.stdout.write(`synced ${String(mappedPages.length)} pages\n`);
    if (result.bareFences > 0) {
      process.stdout.write(`labeled ${String(result.bareFences)} bare fences as text\n`);
    }
    for (const note of result.unsplicedTypeFences) {
      process.stdout.write(`unspliced ts fence: ${note}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

function pageBody(page: MappedPage, readme: string, root: string): string {
  if (page.readmeIntro === true) return readmeIntroduction(readme);
  if (page.readmeSection !== undefined) return extractReadmeH2(readme, page.readmeSection);
  const raw = readFileSync(join(root, page.source), "utf8").replace(/\r\n/g, "\n");
  return stripLeadingH1(raw);
}

function readmeIntroduction(readme: string): string {
  const lines = readme.replace(/\r\n/g, "\n").split("\n");
  const end = lines.findIndex((line, index) => index > 0 && line.startsWith("## "));
  const slice = lines.slice(0, end < 0 ? lines.length : end);
  const withoutTitle = slice[0]?.startsWith("# ") ? slice.slice(1) : slice;
  // The README still says "Version 0.5.0". The sidebar shows the package
  // version. Keep the license name from package.json on that line.
  const license = readRootPackage().license;
  const withoutStaleVersion = withoutTitle.map((line) =>
    line.startsWith("Version ") ? license : line,
  );
  return `${withoutStaleVersion.join("\n").trim()}\n`;
}

function stripLeadingH1(body: string): string {
  return body.replace(/^#[ \t]+[^\n]*\n+/, "");
}

function frontmatter(page: MappedPage): string {
  return [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(page.description)}`,
    `source: ${JSON.stringify(page.source)}`,
    "---",
    "",
  ].join("\n");
}

function parseSamples(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  const parts = raw.replace(/\r\n/g, "\n").split(/^## /m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const heading = (newline < 0 ? part : part.slice(0, newline)).trim();
    const body = newline < 0 ? "" : part.slice(newline + 1);
    const fence = /```(?:ts|tsx)\n[\s\S]*?\n```/.exec(body);
    if (fence?.[0] !== undefined) map.set(heading, fence[0]);
  }
  return map;
}

function spliceSamples(section: string, samples: ReadonlyMap<string, string>): string {
  const lines = section.split("\n");
  const out: string[] = [];
  let pending: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const title = heading[2] ?? "";
      const sample = samples.get(title);
      if (sample !== undefined) pending = sample;
      out.push(line);
      continue;
    }
    if (line.startsWith("```")) {
      let end = index + 1;
      while (end < lines.length && !(lines[end] ?? "").startsWith("```")) end += 1;
      const lang = line.slice(3).trim();
      if (pending !== undefined && (lang === "ts" || lang === "tsx") && end < lines.length) {
        out.push(pending);
        pending = undefined;
        index = end;
        continue;
      }
      const last = Math.min(end, lines.length - 1);
      for (let cursor = index; cursor <= last; cursor += 1) {
        out.push(lines[cursor] ?? "");
      }
      index = last;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function labelBareFences(input: string): { text: string; count: number } {
  let open = false;
  let count = 0;
  const text = input
    .split("\n")
    .map((line) => {
      if (!line.startsWith("```")) return line;
      if (!open) {
        open = true;
        if (line.trim() === "```") {
          count += 1;
          return "```text";
        }
        return line;
      }
      open = false;
      return line;
    })
    .join("\n");
  return { text, count };
}

function noteUnspliced(
  rel: string,
  body: string,
  sampleFences: ReadonlySet<string>,
  notes: string[],
): void {
  if (!rel.startsWith("guides/")) return;
  const { fences } = maskFences(body);
  for (const fence of fences) {
    if (!fence.startsWith("```ts") && !fence.startsWith("```tsx")) continue;
    if (sampleFences.has(fence)) continue;
    const preview = fence.split("\n")[1]?.trim() ?? "";
    notes.push(`${rel}: ${preview}`);
  }
}

/**
 * Point doc-to-doc links at handbook pages. Excluded docs and other repo
 * files point at the GitHub blob. Fenced code is left alone.
 *
 * @param body - Page body
 * @param source - Repo-relative file the links are relative to
 */
export function rewriteDocLinks(body: string, source: string): string {
  const masked = maskFences(body);
  const text = masked.text.replace(/\[[^\]]*\]\(([^)\s]+)\)/g, (full, href: string) => {
    const next = rewriteHref(href, source);
    if (next === href) return full;
    const open = full.lastIndexOf("(");
    return `${full.slice(0, open + 1)}${next})`;
  });
  return unmaskFences(text, masked.fences);
}

function rewriteHref(href: string, source: string): string {
  const hashAt = href.indexOf("#");
  const path = hashAt < 0 ? href : href.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : href.slice(hashAt);
  if (path.length === 0) return href;
  if (path.startsWith("mailto:")) return href;

  if (path.startsWith("https://") || path.startsWith("http://")) {
    const blob = githubBlobPath(path);
    if (blob === undefined) return href;
    if (/^#L\d+$/.test(hash)) return href;
    const page = hrefForRepoPath(blob);
    return page === undefined ? href : `${page}${hash}`;
  }

  const repoPath = posix.normalize(posix.join(posix.dirname(source), path));
  const page = hrefForRepoPath(repoPath);
  if (page !== undefined) return `${page}${hash}`;
  if (excludedDocs.some((item) => item.path === repoPath)) {
    return `${githubBlobUrl(repoPath)}${hash}`;
  }
  if (existsSync(join(repoRoot(), repoPath))) {
    return `${githubBlobUrl(repoPath)}${hash}`;
  }
  return href;
}

function hrefForRepoPath(repoPath: string): string | undefined {
  const whole = mappedPages.filter(
    (page) =>
      page.source === repoPath && page.readmeSection === undefined && page.readmeIntro !== true,
  );
  if (whole.length === 1) return pageHref(whole[0] as MappedPage);
  if (repoPath === "README.md") return "/docs";
  return undefined;
}

function githubBlobPath(url: string): string | undefined {
  const match = /^https:\/\/github\.com\/omqkhafi\/okmodel\/blob\/[^/]+\/([^#?]+)$/.exec(url);
  return match?.[1];
}

function maskFences(input: string): { text: string; fences: string[] } {
  const fences: string[] = [];
  const text = input.replace(/```[\s\S]*?```/g, (fence) => {
    const token = `OKMFENCE${String(fences.length)}END`;
    fences.push(fence);
    return token;
  });
  return { text, fences };
}

function unmaskFences(text: string, fences: readonly string[]): string {
  return text.replace(/OKMFENCE(\d+)END/g, (_full, index: string) => fences[Number(index)] ?? "");
}

function writeMeta(): void {
  const rootPages = mappedPages
    .filter((page) => page.group === "root")
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((page) => page.slug);
  const folders = docGroups
    .slice()
    .sort((a, b) => a.order - b.order)
    .flatMap((group) => [`---${group.title}---`, group.id]);
  writeJson(join(contentDir, "meta.json"), {
    title: "Documentation",
    pages: [...rootPages, ...folders],
  });

  for (const group of docGroups) {
    const pages = mappedPages
      .filter((page) => page.group === group.id)
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((page) => page.slug);
    const dir = join(contentDir, group.id);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, "meta.json"), { title: group.title, pages });
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function markdownFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    }
  };
  walk(dir);
  return files;
}
