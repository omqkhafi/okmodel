import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

/**
 * Byte size of every file under `dir`.
 */
export function distByteSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += distByteSize(path);
      continue;
    }
    if (entry.isFile()) {
      total += statSync(path).size;
    }
  }
  return total;
}

/**
 * Reports when `dir` is missing or larger than `maxBytes`.
 */
export function checkDistSize(dir: string, maxBytes: number): readonly string[] {
  let size: number;
  try {
    size = distByteSize(dir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`size: cannot read ${dir}: ${message}`];
  }
  if (size > maxBytes) {
    return [
      `size: ${dir} is ${String(size)} bytes, above the ceiling of ${String(maxBytes)} bytes`,
    ];
  }
  return [];
}

function readCeiling(path: string): number {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || typeof parsed.maxDistBytes !== "number") {
    throw new Error(`${path} must contain maxDistBytes`);
  }
  return parsed.maxDistBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  const root = repoRoot();
  const maxBytes = readCeiling(join(root, "size-budget.json"));
  const dir = join(root, "dist");
  const problems = checkDistSize(dir, maxBytes);
  if (problems.length === 0) {
    console.log(`size: ${String(distByteSize(dir))} bytes (ceiling ${String(maxBytes)})`);
  }
  exitOnProblems(problems);
}
