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

/**
 * Drops `//` and block comments that sit outside strings.
 *
 * A commented-out `test("...")` is not a proof. Titles inside a string stay.
 *
 * @param source - TypeScript source
 * @returns The source with those comments removed
 */
function stripComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index = Math.min(index + 2, source.length);
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      out += char;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        out += current ?? "";
        if (current === "\\") {
          index += 1;
          if (index < source.length) out += source[index] ?? "";
          index += 1;
          continue;
        }
        index += 1;
        if (current === quote) break;
      }
      continue;
    }
    out += char ?? "";
    index += 1;
  }
  return out;
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
    const text = stripComments(readFileSync(path, "utf8"));
    for (const match of text.matchAll(TITLE)) {
      const title = match[2];
      if (title !== undefined) titles.add(title);
    }
  }
}
