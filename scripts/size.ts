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

/**
 * Cold-import reference on a developer machine, in milliseconds (D127, D134).
 *
 * A local sample above this is a finding. It does not fail the script.
 */
export const LOCAL_COLD_IMPORT_MS = 15;

/**
 * Cold-import gate on CI, in milliseconds (D134).
 *
 * The median of five fresh imports. Shared runners are slower than the
 * reference machine, so the failing gate is wider than {@link LOCAL_COLD_IMPORT_MS}.
 */
export const CI_COLD_IMPORT_MS = 25;

/** Tree-shaken 10-table app. D133. */
export const APP_ENTRY = "scripts/app-startup.ts";

/** Minified app-bundle ceiling, in bytes. */
export const APP_MAX_MIN_BYTES = 48_000;

/** Gzipped app-bundle ceiling, in bytes. */
export const APP_MAX_GZIP_BYTES = 15_800;

/** Adapter entries. Printed beside the runtime budget. They have no separate ceiling. */
export const ADAPTER_ENTRIES = [
  "src/adapters/pg/postgresjs.ts",
  "src/adapters/pg/pglite.ts",
] as const;

/** Ceilings for one minified entry. */
export type EntryCeilings = {
  readonly maxMinBytes: number;
  readonly maxGzipBytes: number;
  readonly maxColdImportMs: number;
};

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
 * Reports when the runtime entry is over a D127 size ceiling or the D134 cold-import gate.
 *
 * Byte ceilings always apply. The cold-import failure applies on CI (25 ms).
 * Locally the 15 ms figure is a finding from {@link coldImportFinding}, not a failure.
 *
 * @param measured - Minified bytes, gzip bytes, and one cold Node import
 * @param options - `ci` selects the 25 ms gate. Defaults to the `CI` environment variable
 * @returns Problem lines. Empty when the entry is inside the ceilings
 */
export function runtimeBudgetProblems(
  measured: RuntimeSize,
  options?: { readonly ci?: boolean },
): readonly string[] {
  return entryBudgetProblems(measured, {
    maxMinBytes: RUNTIME_MAX_MIN_BYTES,
    maxGzipBytes: RUNTIME_MAX_GZIP_BYTES,
    maxColdImportMs: coldImportCeiling(options?.ci ?? ciEnabled()),
  });
}

/**
 * Reports when the 10-table app bundle is over a D133 byte ceiling or the D134 cold-import gate.
 *
 * @param measured - Minified bytes, gzip bytes, and one cold Node import
 * @param options - `ci` selects the 25 ms gate. Defaults to the `CI` environment variable
 * @returns Problem lines. Empty when the bundle is inside the ceilings
 */
export function appBudgetProblems(
  measured: RuntimeSize,
  options?: { readonly ci?: boolean },
): readonly string[] {
  return entryBudgetProblems(measured, {
    maxMinBytes: APP_MAX_MIN_BYTES,
    maxGzipBytes: APP_MAX_GZIP_BYTES,
    maxColdImportMs: coldImportCeiling(options?.ci ?? ciEnabled()),
  });
}

/**
 * A local cold import above the 15 ms reference (D134).
 *
 * @param coldImportMs - Median of five fresh imports
 * @returns The finding, or `undefined` when the sample is within the reference
 */
export function coldImportFinding(coldImportMs: number): string | undefined {
  if (coldImportMs <= LOCAL_COLD_IMPORT_MS) return undefined;
  return `cold import ${coldImportMs.toFixed(3)} ms is above the ${String(LOCAL_COLD_IMPORT_MS)} ms local reference`;
}

/** True when this process is a CI run. */
export function ciEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.CI === "true" || env.CI === "1";
}

function coldImportCeiling(ci: boolean): number {
  return ci ? CI_COLD_IMPORT_MS : Number.POSITIVE_INFINITY;
}

/**
 * Reports when a minified entry is over the given ceilings.
 *
 * @param measured - Minified bytes, gzip bytes, and one cold Node import
 * @param ceilings - Byte and cold-import limits
 * @returns Problem lines. Empty when the entry is inside the ceilings
 */
export function entryBudgetProblems(
  measured: RuntimeSize,
  ceilings: EntryCeilings,
): readonly string[] {
  const problems: string[] = [];
  if (measured.minBytes > ceilings.maxMinBytes) {
    problems.push(
      `size: ${measured.entry} minified is ${String(measured.minBytes)} bytes, above ${String(ceilings.maxMinBytes)}`,
    );
  }
  if (measured.gzipBytes > ceilings.maxGzipBytes) {
    problems.push(
      `size: ${measured.entry} gzip is ${String(measured.gzipBytes)} bytes, above ${String(ceilings.maxGzipBytes)}`,
    );
  }
  if (measured.coldImportMs > ceilings.maxColdImportMs) {
    problems.push(
      `size: ${measured.entry} cold import on Node is ${measured.coldImportMs.toFixed(3)} ms, above ${String(ceilings.maxColdImportMs)}`,
    );
  }
  return problems;
}

/**
 * Minifies the runtime entry, gzips it, and imports it in fresh Node processes.
 *
 * The reported cold import is the median of five processes. The timer wraps
 * `import()` only. Process start is not included.
 *
 * @param root - Repository root
 * @returns Sizes and the cold-import sample
 */
export function measureRuntimeEntry(root: string): RuntimeSize {
  return measureEntry(root, RUNTIME_ENTRY);
}

/**
 * Minifies one entry, gzips it, and imports it in fresh Node processes.
 *
 * The reported cold import is the median of five processes. The timer wraps
 * `import()` only. Process start is not included.
 *
 * A single-entry build inlines that entry's own modules. The published package
 * uses code splitting so those modules are not copied into a second entry.
 *
 * @param root - Repository root
 * @param entry - Source entry, relative to `root`
 * @param external - Packages left outside the bundle
 * @returns Sizes and the cold-import sample
 */
export function measureEntry(
  root: string,
  entry: string,
  external: readonly string[] = [],
): RuntimeSize {
  const parent = external.length > 0 ? join(root, "node_modules") : tmpdir();
  const dir = mkdtempSync(join(parent, external.length > 0 ? ".okm-size-" : "okm-size-"));
  const outfile = join(dir, "runtime.js");
  try {
    const proc = Bun.spawnSync(
      [
        "bun",
        "build",
        join(root, entry),
        "--target",
        "node",
        "--minify",
        "--outfile",
        outfile,
        ...external.flatMap((name) => ["--external", name]),
      ],
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

/** Fresh Node processes sampled for one cold import. The median ignores one slow tick. */
const COLD_IMPORT_SAMPLES = 5;

function coldImportMsOnNode(file: string): number {
  const samples: number[] = [];
  for (let index = 0; index < COLD_IMPORT_SAMPLES; index += 1) {
    samples.push(oneColdImport(file));
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

function oneColdImport(file: string): number {
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

function formatEntry(measured: RuntimeSize, ci: boolean): string {
  const gate = ci
    ? `CI gate ${String(CI_COLD_IMPORT_MS)} ms`
    : `local reference ${String(LOCAL_COLD_IMPORT_MS)} ms`;
  return `size: ${measured.entry} min ${String(measured.minBytes)} bytes, gzip ${String(measured.gzipBytes)} bytes, cold import ${measured.coldImportMs.toFixed(3)} ms (${gate})`;
}

function printColdImportFinding(measured: RuntimeSize, ci: boolean): void {
  if (ci) return;
  const finding = coldImportFinding(measured.coldImportMs);
  if (finding !== undefined) console.log(`size: finding: ${measured.entry} ${finding}`);
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
    const ci = ciEnabled();
    console.log(formatEntry(runtime, ci));
    problems.push(...runtimeBudgetProblems(runtime, { ci }));
    printColdImportFinding(runtime, ci);
    const pg = measureEntry(root, PG_ENTRY);
    console.log(formatEntry(pg, ci));
    for (const entry of ADAPTER_ENTRIES) {
      const adapter = measureEntry(root, entry, ["postgres", "@electric-sql/pglite"]);
      console.log(formatEntry(adapter, ci));
    }
    const app = measureEntry(root, APP_ENTRY);
    console.log(formatEntry(app, ci));
    problems.push(...appBudgetProblems(app, { ci }));
    printColdImportFinding(app, ci);
  } catch (error) {
    problems.push(`size: ${error instanceof Error ? error.message : String(error)}`);
  }
  exitOnProblems(problems);
}
