import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";
import { moduleSpecifiers } from "./specifiers.js";

/**
 * Reports imports of the TypeScript compiler API under `roots`.
 *
 * A directory named `fixtures` is skipped so negative fixtures can live under `tests/`.
 */
export function checkCompilerApi(roots: readonly string[]): readonly string[] {
  const problems: string[] = [];
  for (const root of roots) {
    for (const file of listFiles(root)) {
      const text = readFileSync(file, "utf8");
      for (const specifier of moduleSpecifiers(text)) {
        if (isCompilerApi(specifier)) {
          problems.push(`${file} imports ${specifier}`);
        }
      }
    }
  }
  return problems;
}

function listFiles(dir: string): readonly string[] {
  const files: string[] = [];
  walk(dir, files);
  return files;
}

function walk(dir: string, files: string[]): void {
  const entries = readEntries(dir);
  if (entries === undefined) {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "fixtures" || entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }
}

function readEntries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

function isCompilerApi(specifier: string): boolean {
  return (
    specifier === "typescript" ||
    specifier.startsWith("typescript/") ||
    specifier === "ts-morph" ||
    specifier.startsWith("ts-morph/") ||
    specifier.startsWith("@typescript-eslint/")
  );
}

if (import.meta.main) {
  const root = repoRoot();
  // packages/attest is the TypeScript 6 attest job. It is the one place that
  // may import the compiler API, so it is not scanned here.
  exitOnProblems(
    checkCompilerApi([
      join(root, "src"),
      join(root, "scripts"),
      join(root, "tests"),
      join(root, "packages", "harness"),
      join(root, "packages", "bench"),
      join(root, "packages", "spikes"),
    ]),
  );
}
