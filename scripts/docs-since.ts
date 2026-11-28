/**
 * Derives a handbook page's `since` from the feature registry at `v0.10.6`.
 *
 * A page that names registry keys (frontmatter `feature` or a heading
 * `[feature="…"]`) and whose every key is absent at that tag is `0.11`.
 * Any key present at the tag keeps the page's current `since`. A page with
 * no feature key is left as it is. Re-run from the repository root:
 *
 *   bun ./scripts/docs-since.ts
 *   bun ./scripts/docs-since.ts --write
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./root.js";

/** Tag whose registry is the previous minor. */
const PREVIOUS = "v0.10.6";

/** `since` when every named key is missing from {@link PREVIOUS}. */
const NEXT = "0.11";

const FEATURE_LINE = /^feature:\s*"?([A-Za-z0-9_.-]+)"?\s*$/gm;
const FEATURE_HEADING = /[{[][^}\n]*\bfeature="([^"]+)"[^}\n]*[}\]]/g;
const SINCE_LINE = /^since:\s*"([^"]+)"/m;

type Page = {
  readonly path: string;
  readonly text: string;
  readonly since: string | undefined;
  readonly keys: readonly string[];
};

/**
 * Pages whose `since` this derivation would change, and why.
 *
 * @param root - Repository root
 * @returns One line per changed page
 */
export function sinceChanges(root: string = repoRoot()): readonly string[] {
  const present = keysAt(root, PREVIOUS);
  const lines: string[] = [];
  for (const page of pages(join(root, "site/content/docs"))) {
    if (page.keys.length === 0 || page.since === undefined) continue;
    if (page.keys.some((key) => present.has(key))) continue;
    if (page.since === NEXT) continue;
    lines.push(
      `${page.path}: ${page.since} -> ${NEXT} (${page.keys.join(", ")} absent from ${PREVIOUS})`,
    );
  }
  return lines;
}

/**
 * Writes the derived `since` and returns the same report as {@link sinceChanges}.
 *
 * @param root - Repository root
 * @returns The lines that were written
 */
export function writeSince(root: string = repoRoot()): readonly string[] {
  const present = keysAt(root, PREVIOUS);
  const lines: string[] = [];
  for (const page of pages(join(root, "site/content/docs"))) {
    if (page.keys.length === 0 || page.since === undefined) continue;
    if (page.keys.some((key) => present.has(key))) continue;
    if (page.since === NEXT) continue;
    const next = page.text.replace(SINCE_LINE, `since: "${NEXT}"`);
    writeFileSync(join(root, "site/content/docs", page.path), next);
    lines.push(
      `${page.path}: ${page.since} -> ${NEXT} (${page.keys.join(", ")} absent from ${PREVIOUS})`,
    );
  }
  return lines;
}

function keysAt(root: string, tag: string): ReadonlySet<string> {
  const text = execFileSync("git", ["show", `${tag}:src/tooling/capabilities/postgres.ts`], {
    cwd: root,
    encoding: "utf8",
  });
  const keys = new Set<string>();
  for (const match of text.matchAll(/^ {2}"([^"]+)":/gm)) {
    const key = match[1];
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

function pages(dir: string): Page[] {
  const found: Page[] = [];
  walk(dir, dir, found);
  found.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return found;
}

function walk(root: string, dir: string, found: Page[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(root, path, found);
      continue;
    }
    if (!name.endsWith(".mdx")) continue;
    const text = readFileSync(path, "utf8");
    const body = text.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ""));
    const keys: string[] = [];
    for (const match of body.matchAll(FEATURE_LINE)) {
      const key = match[1];
      if (key !== undefined) keys.push(key);
    }
    for (const match of body.matchAll(FEATURE_HEADING)) {
      const key = match[1];
      if (key !== undefined) keys.push(key);
    }
    found.push({
      path: path.slice(root.length + 1),
      text,
      since: SINCE_LINE.exec(text)?.[1],
      keys,
    });
  }
}

if (import.meta.main) {
  const root = repoRoot();
  const lines = process.argv.includes("--write") ? writeSince(root) : sinceChanges(root);
  for (const line of lines) console.log(line);
  console.log(`${String(lines.length)} page(s)`);
}
