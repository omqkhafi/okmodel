/**
 * Paths from this package back to the OKModel repository root.
 *
 * Turbopack reports `import.meta.url` as the chunk. Above that chunk,
 * Next writes a `package.json` whose only field is `type: commonjs` and
 * which can end with a trailing comma, so it is not valid JSON. Walk until
 * a manifest named `okmodel` instead of parsing the first one on that path.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root (the parent of `site/`). */
export function repoRoot(): string {
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    const found = okmodelRoot(start);
    if (found !== undefined) return found;
  }
  throw new Error("okmodel package.json was not found above the site");
}

/** Absolute path of `site/`. */
export function siteRoot(): string {
  return join(repoRoot(), "site");
}

/**
 * Nearest ancestor whose `package.json` `name` is `okmodel`.
 *
 * A manifest that does not parse is skipped. Next writes one of those
 * under `.next`.
 *
 * @param start - Directory to start from, including itself
 * @returns The repository root, or `undefined` when the walk ends
 */
function okmodelRoot(start: string): string | undefined {
  let current = start;
  for (let depth = 0; depth < 12; depth += 1) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest) && packageName(manifest) === "okmodel") return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * `name` from a package manifest.
 *
 * @param file - Path of a `package.json`
 * @returns The name, or `undefined` when the file is not a named package
 */
function packageName(file: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) return undefined;
  const name = parsed.name;
  return typeof name === "string" ? name : undefined;
}
