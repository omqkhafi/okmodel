/**
 * Repeated prose sentences in the handbook.
 *
 * A sentence is text outside frontmatter, fenced code, headings, tables, and
 * the generated support components. Whitespace is collapsed. The same sentence
 * of 40 or more characters on three or more pages fails. The check names no
 * sentence of its own, so it is not a wording lock. `<SupportPhrase />` and
 * `<Tagline />` are not page text.
 *
 *   bun ./scripts/docs-sentences.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

/** Shortest sentence the repeated-sentence lint counts. */
const MIN_SENTENCE = 40;

/** How many pages may share one sentence before the lint fails. */
const MAX_PAGES = 2;

type PageText = {
  readonly path: string;
  readonly text: string;
};

/**
 * Problems when one sentence appears on too many handbook pages.
 *
 * @param root - Repository root
 * @returns Problem lines. Empty when the lint passes
 */
export function handbookSentenceProblems(root: string = repoRoot()): readonly string[] {
  return repeatedSentenceProblems(handbookPages(join(root, "site/content/docs")));
}

/**
 * Problems for an explicit page list.
 *
 * Used by the handbook lint and by the unit test. A sentence is counted once
 * per page.
 *
 * @param pages - Page path and MDX source
 * @returns Problem lines
 */
export function repeatedSentenceProblems(pages: readonly PageText[]): readonly string[] {
  const owners = new Map<string, string[]>();
  for (const page of pages) {
    for (const sentence of sentencesIn(page.text)) {
      const list = owners.get(sentence);
      if (list === undefined) owners.set(sentence, [page.path]);
      else list.push(page.path);
    }
  }
  const problems: string[] = [];
  for (const [sentence, paths] of owners) {
    if (paths.length <= MAX_PAGES) continue;
    const shown = paths.slice().sort().join(", ");
    problems.push(
      `docs-sentences: ${String(paths.length)} pages share a sentence: ${shown}: ${sentence}`,
    );
  }
  problems.sort();
  return problems;
}

/**
 * Distinct sentences in one page.
 *
 * @param text - MDX source
 * @returns Sentences of {@link MIN_SENTENCE} characters or more
 */
export function sentencesIn(text: string): ReadonlySet<string> {
  const stripped = text
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<\/?(?:SupportPhrase|Tagline)\b[^>]*\/?>/g, "");
  const found = new Set<string>();
  for (const paragraph of stripped.split(/\n\s*\n/)) {
    for (const chunk of chunksOf(paragraph)) {
      const collapsed = chunk.replace(/\s+/g, " ").trim();
      for (const sentence of collapsed.split(/(?<=[.!?])\s+/)) {
        const value = sentence.trim();
        if (value.length >= MIN_SENTENCE) found.add(value);
      }
    }
  }
  return found;
}

function chunksOf(paragraph: string): string[] {
  const chunks: string[] = [];
  const buf: string[] = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    chunks.push(buf.join(" "));
    buf.length = 0;
  };
  for (const line of paragraph.split("\n")) {
    const stripped = line.trim();
    if (stripped.length === 0) continue;
    if (stripped.startsWith("#") || stripped.startsWith("|")) {
      flush();
      continue;
    }
    const marker = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(stripped);
    if (marker !== null) {
      flush();
      const item = marker[1];
      if (item !== undefined && item.length > 0) chunks.push(item);
      continue;
    }
    buf.push(stripped);
  }
  flush();
  return chunks;
}

function handbookPages(dir: string): PageText[] {
  const pages: PageText[] = [];
  walk(dir, dir, pages);
  pages.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return pages;
}

function walk(root: string, dir: string, pages: PageText[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(root, path, pages);
      continue;
    }
    if (!name.endsWith(".mdx")) continue;
    pages.push({
      path: path.slice(root.length + 1),
      text: readFileSync(path, "utf8"),
    });
  }
}

if (import.meta.main) {
  exitOnProblems(handbookSentenceProblems());
}
