import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { listTypeScriptFiles } from "./files.js";
import { type LayerName, isLayerName, layerRank } from "./layers.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";
import { moduleSpecifiers } from "./specifiers.js";

/**
 * Reports relative imports that point upward, and adapter imports that are not contracts.
 *
 * Dependencies point downward only (spec §4.2). An adapter imports `contracts`
 * or other adapter files, not a dialect.
 */
export function checkLayers(root: string): readonly string[] {
  const problems: string[] = [];
  let files: readonly string[];
  try {
    files = listTypeScriptFiles(root);
  } catch (error) {
    return [`layers-check: cannot read ${root}: ${messageOf(error)}`];
  }

  for (const file of files) {
    const from = layerOf(root, file);
    if (from === undefined) {
      problems.push(`${display(root, file)} is outside the layer folders`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    for (const specifier of moduleSpecifiers(text)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const target = resolveRelative(file, specifier);
      if (target === undefined) {
        problems.push(`${display(root, file)} imports ${specifier}, which does not resolve`);
        continue;
      }
      const to = layerOf(root, target);
      if (to === undefined) {
        problems.push(`${display(root, file)} imports ${specifier}, which leaves the layer tree`);
        continue;
      }
      if (!importAllowed(from, to)) {
        problems.push(`${display(root, file)} imports ${specifier} (${to}) from ${from}`);
      }
    }
  }
  return problems;
}

function importAllowed(from: LayerName, to: LayerName): boolean {
  const fromRank = layerRank(from);
  const toRank = layerRank(to);
  if (fromRank === undefined || toRank === undefined) {
    return false;
  }
  if (toRank > fromRank) {
    return false;
  }
  if (from === "adapters" && to !== "contracts" && to !== "adapters") {
    return false;
  }
  return true;
}

function layerOf(root: string, file: string): LayerName | undefined {
  const rel = relative(root, file);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    return undefined;
  }
  const top = rel.split(sep)[0];
  if (top === undefined || !isLayerName(top)) {
    return undefined;
  }
  return top;
}

function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base];
  if (base.endsWith(".js")) {
    const withoutJs = base.slice(0, -3);
    candidates.push(`${withoutJs}.ts`, `${withoutJs}.tsx`, join(withoutJs, "index.ts"));
  }
  candidates.push(`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx"));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

function display(root: string, file: string): string {
  return relative(root, file);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const root = process.argv[2] ?? join(repoRoot(), "src");
  exitOnProblems(checkLayers(root));
}
