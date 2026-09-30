import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

const DECISIONS_FILE = "okmodel-decisions.md";

/**
 * Checks relative links, `§` section references, and decision numbers under `docsDir`.
 *
 * Error-code and milestone checks are later prompts. Section numbers are the
 * heading numbers across the docs directory (`## 4.2 …` satisfies `§4.2`).
 */
export function checkDocs(docsDir: string): readonly string[] {
  const files = markdownFiles(docsDir);
  if (files.length === 0) {
    return [`docs:check: no markdown files in ${docsDir}`];
  }
  const problems: string[] = [];
  const sections = sectionNumbers(files);
  const decisionsPath = join(docsDir, DECISIONS_FILE);
  const defined = existsSync(decisionsPath)
    ? definedDecisions(readFileSync(decisionsPath, "utf8"))
    : undefined;
  if (defined === undefined) {
    problems.push(`docs:check: missing ${DECISIONS_FILE}`);
  }

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const prose = blankFences(text);
    problems.push(...linkProblems(docsDir, file, prose));
    problems.push(...sectionProblems(docsDir, file, prose, sections));
    if (defined !== undefined) {
      problems.push(...decisionProblems(docsDir, file, text, defined));
    }
  }
  return problems;
}

function markdownFiles(dir: string): readonly string[] {
  const files: string[] = [];
  walk(dir, files);
  return files;
}

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
}

function sectionNumbers(files: readonly string[]): ReadonlySet<string> {
  const numbers = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/^#{1,6}\s+(\d+(?:\.\d+)*)\b/gm)) {
      const number = match[1];
      if (number !== undefined) {
        numbers.add(number);
      }
    }
  }
  return numbers;
}

function definedDecisions(text: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(/^\|\s*(D\d+[a-z]?)\s*\|/gm)) {
    const id = match[1];
    if (id !== undefined) {
      ids.add(id);
    }
  }
  return ids;
}

function linkProblems(docsDir: string, file: string, prose: string): readonly string[] {
  const problems: string[] = [];
  const where = relative(docsDir, file);
  for (const match of prose.matchAll(LINK)) {
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }
    const url = raw.trim();
    if (url.length === 0 || isExternal(url)) {
      continue;
    }
    const hashAt = url.indexOf("#");
    const pathPart = hashAt === -1 ? url : url.slice(0, hashAt);
    const hash = hashAt === -1 ? "" : url.slice(hashAt + 1);
    const target = pathPart.length === 0 ? file : resolve(dirname(file), decode(pathPart));
    if (!existsSync(target) || !statSync(target).isFile()) {
      problems.push(`${where} links to ${url}, which does not resolve`);
      continue;
    }
    if (hash.length > 0 && !headingSlugs(readFileSync(target, "utf8")).has(decode(hash))) {
      problems.push(`${where} links to ${url}, whose anchor does not resolve`);
    }
  }
  return problems;
}

function sectionProblems(
  docsDir: string,
  file: string,
  prose: string,
  sections: ReadonlySet<string>,
): readonly string[] {
  const problems: string[] = [];
  const where = relative(docsDir, file);
  for (const match of prose.matchAll(/§\s*(\d+(?:\.\d+)*)/g)) {
    const number = match[1];
    if (number !== undefined && !sections.has(number)) {
      problems.push(`${where} references §${number}, which does not resolve`);
    }
  }
  return problems;
}

function decisionProblems(
  docsDir: string,
  file: string,
  text: string,
  defined: ReadonlySet<string>,
): readonly string[] {
  const problems: string[] = [];
  const where = relative(docsDir, file);
  const seen = new Set<string>();
  for (const match of text.matchAll(/\b(D\d+[a-z]?)\b/g)) {
    const id = match[1];
    if (id === undefined || seen.has(id) || defined.has(id)) {
      continue;
    }
    seen.add(id);
    problems.push(`${where} references ${id}, which is not in ${DECISIONS_FILE}`);
  }
  return problems;
}

function headingSlugs(text: string): ReadonlySet<string> {
  const slugs = new Set<string>();
  const counts = new Map<string, number>();
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const title = match[1];
    if (title === undefined) {
      continue;
    }
    const base = slug(title);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    slugs.add(seen === 0 ? base : `${base}-${String(seen)}`);
  }
  return slugs;
}

function slug(title: string): string {
  const text = title
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase();
  return text
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function blankFences(source: string): string {
  return source.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ""));
}

function isExternal(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

if (import.meta.main) {
  exitOnProblems(checkDocs(join(repoRoot(), "docs")));
}
