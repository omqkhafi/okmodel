import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

/** Published entry the runtime budget measures. D127. */
export const RUNTIME_ENTRY = "src/contracts/index.ts";

/** Postgres entry. Gated at the D135 ceiling. */
export const PG_ENTRY = "src/dialects/pg/index.ts";

/**
 * Minified `okmodel/pg` ceiling, in bytes (D137).
 *
 * Measured 68,611. Plus 3 percent is 70,669, above the 70,500 cap, so the
 * gate is the cap.
 */
export const PG_MAX_MIN_BYTES = 70_500;

/**
 * Gzipped `okmodel/pg` ceiling, in bytes (D137).
 *
 * Measured 21,411. Plus 3 percent is 22,053, above the 22,000 cap, so the
 * gate is the cap.
 */
export const PG_MAX_GZIP_BYTES = 22_000;

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

/**
 * Minified app-fixture ceiling, in bytes (D138).
 *
 * Startup graph measured 74,218. Plus 3 percent is 76,444, under the 86,688 cap.
 */
export const APP_MAX_MIN_BYTES = 76_444;

/**
 * Gzipped app-fixture ceiling, in bytes (D138).
 *
 * Startup graph measured 24,471. Plus 3 percent is 25,205, under the 27,800 cap.
 */
export const APP_MAX_GZIP_BYTES = 25_205;

/**
 * Public connect entries, driver left external (D137).
 *
 * The startup graph excludes chunks loaded on first failure, include, or checkout.
 * Gates are the measured startup size plus 5 percent.
 */
export const CONNECT_ENTRIES = [
  {
    entry: "src/runtime/pg/postgresjs.ts",
    file: "postgresjs.js",
    external: ["postgres"],
    maxMinBytes: 36_713,
    maxGzipBytes: 12_837,
  },
  {
    entry: "src/runtime/pg/pglite.ts",
    file: "pglite.js",
    external: ["@electric-sql/pglite"],
    maxMinBytes: 35_439,
    maxGzipBytes: 12_531,
  },
] as const;

/** Operator modules the app fixture does not import. They must not be in its startup graph. */
const SHAKEN_OPERATORS = [
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
  "startsWith",
  "contains",
  "endsWith",
  "like",
  "ilike",
  "inList",
  "notIn",
  "not",
  "or",
  "has",
  "none",
  "every",
] as const;

/**
 * Adapter entries.
 *
 * Cold import is printed and not gated (D135): the driver packages dominate it.
 * Byte ceilings are the P14 measurement plus 25 percent. OkmError is in these
 * bundles, so the P13 figures no longer fit.
 */
export const ADAPTER_ENTRIES = [
  {
    entry: "src/adapters/pg/postgresjs.ts",
    external: ["postgres"],
    maxMinBytes: 19_850,
    maxGzipBytes: 6_870,
  },
  {
    entry: "src/adapters/pg/pglite.ts",
    external: ["@electric-sql/pglite"],
    maxMinBytes: 17_870,
    maxGzipBytes: 6_230,
  },
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
 * Startup graph plus the lazy chunks that load on first include, failure, or write.
 *
 * The gate uses {@link RuntimeSize}. The total is reported and not gated (D138).
 */
export type StartupMeasurement = RuntimeSize & {
  readonly totalMinBytes: number;
  readonly totalGzipBytes: number;
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
 * Reports when the 10-table app bundle is over its D137 byte gate.
 *
 * Cold import is printed with the measurement. The 25 ms CI failure stays on
 * the runtime entry (D134). This bundle runs `schema()` at import, so that
 * sample is not the same gate.
 *
 * @param measured - Minified bytes, gzip bytes, and one cold Node import
 * @returns Problem lines. Empty when the bundle is inside the ceilings
 */
export function appBudgetProblems(measured: RuntimeSize): readonly string[] {
  return entryBudgetProblems(measured, {
    maxMinBytes: APP_MAX_MIN_BYTES,
    maxGzipBytes: APP_MAX_GZIP_BYTES,
    maxColdImportMs: Number.POSITIVE_INFINITY,
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

const staticImport = /from\s*"(\.\/[^"]+)"/g;
const dynamicImport = /import\s*\(\s*"(\.\/[^"]+)"\s*\)/g;
const sideEffectImport = /import\s*"(\.\/[^"]+)"/g;

/**
 * Minifies an entry with splitting and counts only the static-import graph.
 *
 * `import()` chunks load later (first failure, first include, first checkout).
 * They are not part of cold start. Gzip is the concatenation of the startup chunks.
 *
 * @param root - Repository root
 * @param entry - Source entry, relative to `root`
 * @param file - Built entry filename
 * @param external - Packages left outside the bundle
 * @returns Sizes and the cold-import sample of the entry file
 */
export function measureStartup(
  root: string,
  entry: string,
  file: string,
  external: readonly string[] = [],
): StartupMeasurement {
  const parent = external.length > 0 ? join(root, "node_modules") : tmpdir();
  const dir = mkdtempSync(join(parent, external.length > 0 ? ".okm-size-" : "okm-size-"));
  try {
    const proc = Bun.spawnSync(
      [
        "bun",
        "build",
        join(root, entry),
        "--target",
        "node",
        "--minify",
        "--splitting",
        "--outdir",
        dir,
        ...external.flatMap((name) => ["--external", name]),
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      throw new Error(
        `bun build ${entry} exited ${String(proc.exitCode)}\n${proc.stderr.toString()}`,
      );
    }
    const startup = new Set<string>();
    const lazy = new Set<string>();
    walkStartup(dir, file, startup, lazy);
    for (const name of lazy) startup.delete(name);
    const parts: Buffer[] = [];
    let minBytes = 0;
    for (const name of startup) {
      const bytes = readFileSync(join(dir, name));
      minBytes += bytes.byteLength;
      parts.push(bytes);
    }
    const all = new Set<string>();
    walkAll(dir, file, all);
    const totalParts: Buffer[] = [];
    let totalMinBytes = 0;
    for (const name of [...all].sort()) {
      const bytes = readFileSync(join(dir, name));
      totalMinBytes += bytes.byteLength;
      totalParts.push(bytes);
    }
    const outfile = join(dir, file);
    return {
      entry,
      minBytes,
      gzipBytes: gzipSync(Buffer.concat(parts), { level: 9 }).byteLength,
      coldImportMs: coldImportMsOnNode(outfile),
      totalMinBytes,
      totalGzipBytes: gzipSync(Buffer.concat(totalParts), { level: 9 }).byteLength,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function walkAll(dir: string, file: string, seen: Set<string>): void {
  if (seen.has(file)) return;
  seen.add(file);
  const text = readFileSync(join(dir, file), "utf8");
  for (const pattern of [dynamicImport, staticImport, sideEffectImport]) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1]?.replace("./", "");
      if (name !== undefined) walkAll(dir, name, seen);
    }
  }
}

function walkStartup(dir: string, file: string, seen: Set<string>, lazy: Set<string>): void {
  if (seen.has(file)) return;
  seen.add(file);
  const text = readFileSync(join(dir, file), "utf8");
  for (const match of text.matchAll(dynamicImport)) {
    const name = match[1]?.replace("./", "");
    if (name !== undefined) lazy.add(name);
  }
  for (const match of text.matchAll(staticImport)) {
    const name = match[1]?.replace("./", "");
    if (name !== undefined && !lazy.has(name)) walkStartup(dir, name, seen, lazy);
  }
  for (const match of text.matchAll(sideEffectImport)) {
    const name = match[1]?.replace("./", "");
    if (name !== undefined && !lazy.has(name)) walkStartup(dir, name, seen, lazy);
  }
}

/**
 * Fails when the app fixture's startup graph contains an operator it does not import.
 *
 * @param root - Repository root
 * @returns Problem lines. Empty when only `eq` is present
 */
export function shakenOperatorProblems(root: string): readonly string[] {
  const dir = mkdtempSync(join(tmpdir(), "okm-shake-"));
  try {
    const proc = Bun.spawnSync(
      [
        "bun",
        "build",
        join(root, APP_ENTRY),
        "--target",
        "node",
        "--splitting",
        "--outdir",
        dir,
        "--external",
        "postgres",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      return [`size: operator shake build exited ${String(proc.exitCode)}`];
    }
    let text = "";
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".js")) continue;
      text += readFileSync(join(dir, name), "utf8");
    }
    const problems: string[] = [];
    if (!text.includes("src/dialects/pg/ops/eq.ts")) {
      problems.push("size: app fixture dropped eq, which it imports");
    }
    for (const name of SHAKEN_OPERATORS) {
      if (text.includes(`src/dialects/pg/ops/${name}.ts`)) {
        problems.push(`size: app fixture kept okmodel/pg operator ${name}`);
      }
    }
    return problems;
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

function printQueryLatency(root: string): readonly string[] {
  const proc = Bun.spawnSync(["bun", join(root, "scripts/query-latency.ts")], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = proc.stdout.toString().trim();
  if (output.length > 0) console.log(output);
  if (proc.exitCode !== 0) {
    return [
      `size: query latency exited ${String(proc.exitCode)}\n${proc.stderr.toString()}${output}`,
    ];
  }
  return [];
}

function formatTotal(measured: StartupMeasurement): string {
  return `size: ${measured.entry} total graph min ${String(measured.totalMinBytes)} bytes, gzip ${String(measured.totalGzipBytes)} bytes (lazy chunks included, not gated)`;
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

if (import.meta.main) {
  const root = repoRoot();
  const dir = join(root, "dist");
  const problems: string[] = [];
  try {
    console.log(`size: dist ${String(distByteSize(dir))} bytes (reported, not gated)`);
  } catch (error) {
    problems.push(
      `size: cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const runtime = measureRuntimeEntry(root);
    const ci = ciEnabled();
    console.log(formatEntry(runtime, ci));
    problems.push(...runtimeBudgetProblems(runtime, { ci }));
    printColdImportFinding(runtime, ci);
    const pg = measureEntry(root, PG_ENTRY);
    console.log(formatEntry(pg, ci));
    problems.push(
      ...entryBudgetProblems(pg, {
        maxMinBytes: PG_MAX_MIN_BYTES,
        maxGzipBytes: PG_MAX_GZIP_BYTES,
        maxColdImportMs: Number.POSITIVE_INFINITY,
      }),
    );
    for (const entry of ADAPTER_ENTRIES) {
      const adapter = measureEntry(root, entry.entry, entry.external);
      console.log(formatEntry(adapter, ci));
      problems.push(
        ...entryBudgetProblems(adapter, {
          maxMinBytes: entry.maxMinBytes,
          maxGzipBytes: entry.maxGzipBytes,
          maxColdImportMs: Number.POSITIVE_INFINITY,
        }),
      );
    }
    const app = measureStartup(root, APP_ENTRY, "app-startup.js", ["postgres"]);
    console.log(formatEntry(app, ci));
    console.log(formatTotal(app));
    problems.push(...appBudgetProblems(app));
    printColdImportFinding(app, ci);
    problems.push(...shakenOperatorProblems(root));
    problems.push(...printQueryLatency(root));
    for (const entry of CONNECT_ENTRIES) {
      const measured = measureStartup(root, entry.entry, entry.file, entry.external);
      console.log(formatEntry(measured, ci));
      console.log(formatTotal(measured));
      problems.push(
        ...entryBudgetProblems(measured, {
          maxMinBytes: entry.maxMinBytes,
          maxGzipBytes: entry.maxGzipBytes,
          maxColdImportMs: Number.POSITIVE_INFINITY,
        }),
      );
    }
  } catch (error) {
    problems.push(`size: ${error instanceof Error ? error.message : String(error)}`);
  }
  exitOnProblems(problems);
}
