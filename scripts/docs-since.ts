/**
 * Derives a handbook page's `since` from the file at tag `v0.10.6`.
 *
 * A page is `"0.11"` when its file does not exist at that tag. `git diff -M`
 * follows renames, so a moved page keeps the value it already has. A page
 * that existed at the tag keeps its current `since`. A `"0.11"` on a file
 * that existed was derived from registry keys and is put back to `"0.10"`.
 * Pages with no `since` stay as they are. Re-run from the repository root:
 *
 *   bun ./scripts/docs-since.ts
 *   bun ./scripts/docs-since.ts --write
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./root.js";

/** Tag whose tree is the previous minor. */
const PREVIOUS = "v0.10.6";

/** `since` for a page whose file is absent at {@link PREVIOUS}. */
const NEXT = "0.11";

/** `since` restored when a file that existed was marked {@link NEXT}. */
const PREVIOUS_MINOR = "0.10";

const SINCE_LINE = /^since:\s*"([^"]+)"/m;

type Page = {
  readonly path: string;
  readonly text: string;
  readonly since: string;
  readonly existed: boolean;
};

/**
 * `since` for one page.
 *
 * A new file is `"0.11"`. A file that existed keeps its value, and a `"0.11"`
 * on that file becomes `"0.10"`.
 *
 * @param existed - The file, or a rename of it, is in `v0.10.6`
 * @param current - The `since` already in the file
 */
export function targetSince(existed: boolean, current: string): string {
  if (!existed) return NEXT;
  if (current === NEXT) return PREVIOUS_MINOR;
  return current;
}

/**
 * Rename destinations from `git diff -M --name-status`.
 *
 * The map is the new path to the old path. A score prefix such as `R095`
 * counts. Copies do not.
 *
 * @param nameStatus - Output of `git diff -M --name-status`
 */
export function renameDestinations(nameStatus: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const line of nameStatus.split("\n")) {
    if (!line.startsWith("R")) continue;
    const parts = line.split("\t");
    const from = parts[1];
    const to = parts[2];
    if (from === undefined || to === undefined || to.length === 0) continue;
    map.set(to, from);
  }
  return map;
}

/**
 * Pages whose `since` this derivation would change.
 *
 * @param root - Repository root
 * @returns One line per changed page
 */
export function sinceChanges(root: string = repoRoot()): readonly string[] {
  return report(root, false);
}

/**
 * Writes the derived `since` and returns the same report as {@link sinceChanges}.
 *
 * @param root - Repository root
 * @returns The lines that were written
 */
export function writeSince(root: string = repoRoot()): readonly string[] {
  return report(root, true);
}

/**
 * Derived `since` for every handbook page that already has one.
 *
 * @param root - Repository root
 */
export function sinceTargets(root: string = repoRoot()): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const page of pagesWithSince(root))
    map.set(page.path, targetSince(page.existed, page.since));
  return map;
}

/**
 * Handbook pages under `site/content/docs` that have no `since` field.
 *
 * @param root - Repository root
 * @returns Paths relative to `site/content/docs`
 */
export function pagesWithoutSince(root: string = repoRoot()): readonly string[] {
  const dir = join(root, "site/content/docs");
  const found: string[] = [];
  walk(dir, dir, (path, text) => {
    if (SINCE_LINE.exec(text) === null) found.push(path);
  });
  found.sort();
  return found;
}

function report(root: string, write: boolean): readonly string[] {
  const lines: string[] = [];
  const docs = join(root, "site/content/docs");
  for (const page of pagesWithSince(root)) {
    const target = targetSince(page.existed, page.since);
    if (target === page.since) continue;
    if (write) {
      const next = page.text.replace(SINCE_LINE, `since: "${target}"`);
      writeFileSync(join(docs, page.path), next);
    }
    const why = page.existed ? `existed at ${PREVIOUS}` : `new since ${PREVIOUS}`;
    lines.push(`${page.path}: ${page.since} -> ${target} (${why})`);
  }
  lines.sort();
  return lines;
}

function pagesWithSince(root: string): readonly Page[] {
  const dir = join(root, "site/content/docs");
  const renames = renameDestinations(nameStatus(root));
  const found: Page[] = [];
  walk(dir, dir, (path, text) => {
    const since = SINCE_LINE.exec(text)?.[1];
    if (since === undefined) return;
    const old = renames.get(`site/content/docs/${path}`);
    const existed =
      gitHas(root, `site/content/docs/${path}`) || (old !== undefined && gitHas(root, old));
    found.push({ path, text, since, existed });
  });
  return found;
}

function nameStatus(root: string): string {
  return execFileSync(
    "git",
    ["diff", "-M", "--name-status", PREVIOUS, "HEAD", "--", "site/content/docs"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
}

function gitHas(root: string, path: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${PREVIOUS}:${path}`], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function walk(root: string, dir: string, visit: (path: string, text: string) => void): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(root, path, visit);
      continue;
    }
    if (!name.endsWith(".mdx")) continue;
    visit(path.slice(root.length + 1), readFileSync(path, "utf8"));
  }
}

if (import.meta.main) {
  const root = repoRoot();
  const lines = process.argv.includes("--write") ? writeSince(root) : sinceChanges(root);
  for (const line of lines) console.log(line);
  console.log(`${String(lines.length)} page(s)`);
}
