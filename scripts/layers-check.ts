import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { listTypeScriptFiles } from "./files.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";
import { moduleSpecifiers } from "./specifiers.js";

const LAYERS = [
  { dir: "l0-contracts", name: "L0 contracts" },
  { dir: "l1-dialects", name: "L1 dialects" },
  { dir: "l2-adapters", name: "L2 adapters" },
  { dir: "l3-runtime", name: "L3 runtime" },
  { dir: "l4-tooling", name: "L4 tooling" },
] as const;

/**
 * Reports relative imports that point upward, and adapter imports that are not L0 or L2.
 *
 * Dependencies point downward only (spec §4.2). An adapter imports L0 contracts
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
        const fromName = LAYERS[from]?.name ?? String(from);
        const toName = LAYERS[to]?.name ?? String(to);
        problems.push(`${display(root, file)} imports ${specifier} (${toName}) from ${fromName}`);
      }
    }
  }
  return problems;
}

function importAllowed(from: number, to: number): boolean {
  if (to > from) {
    return false;
  }
  if (from === 2 && to !== 0 && to !== 2) {
    return false;
  }
  return true;
}

function layerOf(root: string, file: string): number | undefined {
  const rel = relative(root, file);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    return undefined;
  }
  const top = rel.split(sep)[0];
  if (top === undefined) {
    return undefined;
  }
  const index = LAYERS.findIndex((layer) => layer.dir === top);
  return index === -1 ? undefined : index;
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
