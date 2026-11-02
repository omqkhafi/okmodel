/**
 * Site code that runs on every request in production. On Vercel the function
 * holds only `site/` (Root Directory), so nothing reachable from here may
 * read the repository tree: no `lib/repo.ts`, no `lib/markdown-source.ts`,
 * no `node:fs`. Build-time routes (prerendered) and tests may.
 *
 * `scripts/standalone-smoke.ts` compares this list with the dynamic routes
 * a build reports, so a route that turns dynamic must be added here.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of `site/`. */
export const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Entry files, relative to `site/`, that Next runs at request time. */
export const REQUEST_TIME_ENTRIES = ["proxy.ts", "app/api/search/route.ts"] as const;

/** Site files that read the repository. */
const FORBIDDEN_FILES = new Set(["lib/repo.ts", "lib/markdown-source.ts"]);

/** Specifiers that reach the filesystem. */
const FORBIDDEN_SPECIFIERS = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);

const CODE = /\.(?:tsx?|mjs|js)$/;
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];

/** One forbidden reach: the import chain from the entry, ending at the hit. */
export type ForbiddenReach = {
  readonly entry: string;
  readonly chain: readonly string[];
};

/**
 * Every forbidden file or specifier reachable from one entry through local
 * imports. `node_modules` is not followed.
 *
 * @param entry - Entry path relative to `site/`
 */
export function forbiddenReaches(entry: string): readonly ForbiddenReach[] {
  const transpiler = {
    ts: new Bun.Transpiler({ loader: "ts" }),
    tsx: new Bun.Transpiler({ loader: "tsx" }),
  };
  const hits: ForbiddenReach[] = [];
  const parent = new Map<string, string | undefined>([[entry, undefined]]);
  const queue = [entry];
  const chainTo = (file: string): string[] => {
    const chain: string[] = [];
    for (let at: string | undefined = file; at !== undefined; at = parent.get(at)) chain.unshift(at);
    return chain;
  };
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (FORBIDDEN_FILES.has(file)) {
      hits.push({ entry, chain: chainTo(file) });
      continue;
    }
    const source = readFileSync(join(SITE_DIR, file), "utf8");
    const scan = (file.endsWith(".tsx") ? transpiler.tsx : transpiler.ts).scanImports(source);
    for (const { path: specifier } of scan) {
      if (FORBIDDEN_SPECIFIERS.has(specifier)) {
        hits.push({ entry, chain: [...chainTo(file), specifier] });
        continue;
      }
      const next = resolveLocal(file, specifier);
      if (next === undefined || parent.has(next)) continue;
      parent.set(next, file);
      queue.push(next);
    }
  }
  return hits;
}

/**
 * Site-relative path of a local import, or `undefined` for a package or a
 * non-code file (MDX, JSON, CSS).
 *
 * @param from - Importing file relative to `site/`
 * @param specifier - Import specifier
 */
function resolveLocal(from: string, specifier: string): string | undefined {
  const bare = specifier.split("?", 1)[0] ?? specifier;
  let base: string;
  if (bare.startsWith("@/")) base = join(SITE_DIR, bare.slice(2));
  else if (bare.startsWith("collections/")) base = join(SITE_DIR, ".source", bare.slice(12));
  else if (bare.startsWith(".")) base = join(SITE_DIR, dirname(from), bare);
  else return undefined;
  for (const extension of EXTENSIONS) {
    const candidate = base + extension;
    if (CODE.test(candidate) && existsSync(candidate)) return relative(SITE_DIR, candidate);
  }
  return undefined;
}
