import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

/** Published entry the runtime budget measures. D127. */
export const RUNTIME_ENTRY = "src/contracts/index.ts";

/** Postgres entry. Printed beside the runtime budget. It has no separate ceiling. */
export const PG_ENTRY = "src/dialects/pg/index.ts";

/** Minified runtime entry ceiling, in bytes (60 KB). */
export const RUNTIME_MAX_MIN_BYTES = 60 * 1024;

/** Gzipped runtime entry ceiling, in bytes (20 KB). */
export const RUNTIME_MAX_GZIP_BYTES = 20 * 1024;

/** Cold `import()` ceiling on Node, in milliseconds. The script also prints the sample. */
export const RUNTIME_MAX_COLD_IMPORT_MS = 15;

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

/** Byte and import measurements for the runtime entry. */
export type RuntimeSize = {
  readonly entry: string;
  readonly minBytes: number;
  readonly gzipBytes: number;
  readonly coldImportMs: number;
};

/**
 * Reports when the runtime entry is over a D127 size or cold-import ceiling.
 *
 * @param measured - Minified bytes, gzip bytes, and one cold Node import
 * @returns Problem lines. Empty when the entry is inside the ceilings
 */
export function runtimeBudgetProblems(measured: RuntimeSize): readonly string[] {
  const problems: string[] = [];
  if (measured.minBytes > RUNTIME_MAX_MIN_BYTES) {
    problems.push(
      `size: ${measured.entry} minified is ${String(measured.minBytes)} bytes, above ${String(RUNTIME_MAX_MIN_BYTES)}`,
    );
  }
  if (measured.gzipBytes > RUNTIME_MAX_GZIP_BYTES) {
    problems.push(
      `size: ${measured.entry} gzip is ${String(measured.gzipBytes)} bytes, above ${String(RUNTIME_MAX_GZIP_BYTES)}`,
    );
  }
  if (measured.coldImportMs > RUNTIME_MAX_COLD_IMPORT_MS) {
    problems.push(
      `size: ${measured.entry} cold import on Node is ${measured.coldImportMs.toFixed(3)} ms, above ${String(RUNTIME_MAX_COLD_IMPORT_MS)}`,
    );
  }
  return problems;
}

/**
 * Minifies the runtime entry, gzips it, and imports it once in a fresh Node process.
 *
 * The timer wraps `import()` only. Process start is not included.
 *
 * @param root - Repository root
 * @returns Sizes and the cold-import sample
 */
export function measureRuntimeEntry(root: string): RuntimeSize {
  return measureEntry(root, RUNTIME_ENTRY);
}

/**
 * Minifies one entry, gzips it, and imports it once in a fresh Node process.
 *
 * A single-entry build inlines that entry's own modules. The published package
 * uses code splitting so those modules are not copied into a second entry.
 *
 * @param root - Repository root
 * @param entry - Source entry, relative to `root`
 * @returns Sizes and the cold-import sample
 */
export function measureEntry(root: string, entry: string): RuntimeSize {
  const dir = mkdtempSync(join(tmpdir(), "okm-size-"));
  const outfile = join(dir, "runtime.js");
  try {
    const proc = Bun.spawnSync(
      ["bun", "build", join(root, entry), "--target", "node", "--minify", "--outfile", outfile],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      throw new Error(
        `bun build ${entry} exited ${String(proc.exitCode)}\n${proc.stderr.toString()}`,
      );
    }
    const bytes = readFileSync(outfile);
    const coldImportMs = coldImportMsOnNode(outfile);
    return {
      entry,
      minBytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
      coldImportMs,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function coldImportMsOnNode(file: string): number {
  const href = pathToFileURL(file).href;
  const source = `const started = performance.now(); await import(${JSON.stringify(href)}); process.stdout.write(String(performance.now() - started));`;
  const proc = Bun.spawnSync(["node", "--input-type=module", "-e", source], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = proc.stdout.toString().trim();
  if (proc.exitCode !== 0) {
    throw new Error(`node cold import exited ${String(proc.exitCode)}\n${proc.stderr.toString()}`);
  }
  const ms = Number(output);
  if (!Number.isFinite(ms)) {
    throw new Error(`node cold import did not print a time: ${output}`);
  }
  return ms;
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
  const problems = [...checkDistSize(dir, maxBytes)];
  if (problems.length === 0) {
    console.log(`size: dist ${String(distByteSize(dir))} bytes (ceiling ${String(maxBytes)})`);
  }
  try {
    const runtime = measureRuntimeEntry(root);
    console.log(
      `size: ${runtime.entry} min ${String(runtime.minBytes)} bytes, gzip ${String(runtime.gzipBytes)} bytes, cold import ${runtime.coldImportMs.toFixed(3)} ms`,
    );
    problems.push(...runtimeBudgetProblems(runtime));
    const pg = measureEntry(root, PG_ENTRY);
    console.log(
      `size: ${pg.entry} min ${String(pg.minBytes)} bytes, gzip ${String(pg.gzipBytes)} bytes, cold import ${pg.coldImportMs.toFixed(3)} ms`,
    );
  } catch (error) {
    problems.push(`size: ${error instanceof Error ? error.message : String(error)}`);
  }
  exitOnProblems(problems);
}
