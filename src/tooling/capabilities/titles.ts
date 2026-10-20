/**
 * Reads literal `test("...")` titles for the registry proof check.
 *
 * Loaded by the registry test, not by `describe()`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TITLE = /\b(?:test|it)\(\s*(["'])((?:\\.|(?!\1).)*)\1/g;

/**
 * Literal test titles under `roots`.
 *
 * Template titles are ignored. A proof has to be a string literal.
 *
 * @param roots - Directories to scan
 * @returns Titles
 */
export function collectTestTitles(roots: readonly string[]): ReadonlySet<string> {
  const titles = new Set<string>();
  for (const root of roots) walk(root, titles);
  return titles;
}

function walk(directory: string, titles: Set<string>): void {
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(directory, name);
    const info = statSync(path);
    if (info.isDirectory()) {
      walk(path, titles);
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(TITLE)) {
      const title = match[2];
      if (title !== undefined) titles.add(title);
    }
  }
}
