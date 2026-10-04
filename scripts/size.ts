import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

/** Published entry the runtime budget measures. D127. */
export const RUNTIME_ENTRY = "src/contracts/index.ts";

/**
 * Postgres barrel. Printed, not gated (D141, P17).
 *
 * The barrel exports every builder, so its size counts features. The app
 * fixture and {@link exportShakeProblems} are the gates.
 */
export const PG_ENTRY = "src/dialects/pg/index.ts";

/**
 * Minified runtime entry ceiling, in bytes (D144).
 *
 * Measured 5,525. Plus 10 percent, rounded to 6,100. The 60 KB figure stays
 * the long-term target in D127; this gate is the one that fails CI.
 */
export const RUNTIME_MAX_MIN_BYTES = 6_100;

/**
 * Gzipped runtime entry ceiling, in bytes (D144).
 *
 * Measured 2,042. Plus 10 percent, rounded to 2,250.
 */
export const RUNTIME_MAX_GZIP_BYTES = 2_250;

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

/** The same app with `archivable()` on one table. Reported, not gated (D167). */
export const ARCHIVABLE_ENTRY = "scripts/app-archivable.ts";

/** The same app with validation on. Reported, not gated. */
export const VALIDATE_ENTRY = "scripts/app-validate.ts";

/** The same app using `manyThrough`, `page` and `aggregate`. Reported, not gated (D176). */
export const RELATIONS_ENTRY = "scripts/app-relations.ts";

/**
 * Minified app-fixture ceiling, in bytes (D160).
 *
 * P27 measured 88,278. Plus 3 percent, rounded down, is 90,900, under the 91,000 allowance (D143).
 * Was 87,900 (P24).
 */
export const APP_MAX_MIN_BYTES = 90_900;

/**
 * Gzipped app-fixture ceiling, in bytes (D160).
 *
 * P27 measured 29,326. Plus 3 percent is 30,206, so the 30,000 allowance (D143) is the gate.
 * Was 29,210 (P24).
 */
export const APP_MAX_GZIP_BYTES = 30_000;

/**
 * Public connect entries, driver left external (D142, D143, D156).
 *
 * The startup graph excludes chunks loaded on first failure, include, or the
 * mismatch path of the catalog check. Each ceiling is the measurement
 * plus 3 percent, rounded down (D160). Moved in P27. Cold import is printed,
 * including a driver-stubbed sample, and is not gated. Bun.sql has no Node
 * cold import.
 */
export const CONNECT_ENTRIES = [
  {
    entry: "src/runtime/pg/postgresjs.ts",
    file: "postgresjs.js",
    external: ["postgres"],
    maxMinBytes: 41_600,
    maxGzipBytes: 14_600,
  },
  {
    entry: "src/runtime/pg/pglite.ts",
    file: "pglite.js",
    external: ["@electric-sql/pglite"],
    maxMinBytes: 39_300,
    maxGzipBytes: 13_980,
  },
  {
    entry: "src/runtime/pg/pg.ts",
    file: "pg.js",
    external: ["pg"],
    maxMinBytes: 42_400,
    maxGzipBytes: 14_920,
  },
  {
    entry: "src/runtime/pg/bun.ts",
    file: "bun.js",
    external: ["bun"],
    nodeColdImport: false,
    maxMinBytes: 41_200,
    maxGzipBytes: 14_470,
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
  "containedBy",
  "overlaps",
  "hasKey",
  "hasAnyKey",
  "path",
  "matches",
  "json-set",
  "json-ns",
  "arr-append",
  "arr-remove",
  "arr-ns",
] as const;

/**
 * Adapter entries.
 *
 * The gate is minified bytes that are not already in the runtime entry.
 * A standalone bundle counts that shared code again. Cold import is printed
 * and not gated (D135): the driver packages dominate it.
 *
 * Ceilings are the P17 measurement plus 25 percent (D127).
 */
export const ADAPTER_ENTRIES = [
  {
    entry: "src/adapters/pg/postgresjs.ts",
    external: ["postgres"],
    maxIncrementalMinBytes: 15_093,
  },
  {
    entry: "src/adapters/pg/pglite.ts",
    external: ["@electric-sql/pglite"],
    maxIncrementalMinBytes: 12_010,
  },
] as const;

/** One export that must keep its module and drop the others. */
export type ExportShake = {
  /** Module the import names. */
  readonly from: string;
  /** Export name to import. */
  readonly name: string;
  /**
   * Expression that must stay live.
   *
   * Defaults to {@link ExportShake.name}. A namespace member is `arr.append`.
   */
  readonly use?: string;
  /** Path fragment that must remain. */
  readonly keep: string;
  /** Path fragments that must be absent. */
  readonly drop: readonly string[];
};

/** One barrel export that must not keep unrelated modules. */
const EXPORT_SHAKES: readonly ExportShake[] = [
  {
    from: "src/dialects/pg/index.ts",
    name: "text",
    keep: "src/dialects/pg/text.ts",
    drop: ["src/dialects/pg/search.ts", "src/dialects/pg/geometry.ts", "src/dialects/pg/enum.ts"],
  },
  {
    from: "src/dialects/pg/index.ts",
    name: "eq",
    keep: "src/dialects/pg/ops/eq.ts",
    drop: ["src/dialects/pg/ops/lt.ts", "src/dialects/pg/ops/gt.ts", "src/dialects/pg/ops/like.ts"],
  },
  {
    from: "src/dialects/pg/index.ts",
    name: "json",
    use: "json.set",
    keep: "src/dialects/pg/ops/json-set.ts",
    drop: ["src/dialects/pg/ops/arr-append.ts", "src/dialects/pg/ops/arr-remove.ts"],
  },
  {
    from: "src/dialects/pg/index.ts",
    name: "arr",
    use: "arr.append",
    keep: "src/dialects/pg/ops/arr-append.ts",
    drop: ["src/dialects/pg/ops/arr-remove.ts", "src/dialects/pg/ops/json-set.ts"],
  },
  {
    from: "src/dialects/pg/index.ts",
    name: "arr",
    use: "arr.remove",
    keep: "src/dialects/pg/ops/arr-remove.ts",
    drop: ["src/dialects/pg/ops/arr-append.ts", "src/dialects/pg/ops/json-set.ts"],
  },
];

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
  /** Cold import after the driver package is replaced with an empty module. */
  readonly stubbedColdImportMs?: number;
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
 * @param stubSpecifier - When set, a second import replaces this package with an empty module
 * @param nodeImport - When false, skip the Node cold import. Bun.sql has no Node build
 * @returns Sizes and the cold-import sample of the entry file
 */
export function measureStartup(
  root: string,
  entry: string,
  file: string,
  external: readonly string[] = [],
  stubSpecifier?: string,
  nodeImport = true,
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
    const coldImportMs = nodeImport ? coldImportMsOnNode(outfile) : 0;
    const stubbedColdImportMs =
      stubSpecifier === undefined ? undefined : stubbedImport(dir, outfile, stubSpecifier);
    return {
      entry,
      minBytes,
      gzipBytes: gzipSync(Buffer.concat(parts), { level: 9 }).byteLength,
      coldImportMs,
      totalMinBytes,
      totalGzipBytes: gzipSync(Buffer.concat(totalParts), { level: 9 }).byteLength,
      ...(stubbedColdImportMs !== undefined ? { stubbedColdImportMs } : {}),
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
 * Fails when the app fixture's startup graph contains an operator it does not import,
 * or the timestamps trait and its clock.
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
    const startup = new Set<string>();
    const lazy = new Set<string>();
    walkStartup(dir, "app-startup.js", startup, lazy);
    for (const name of lazy) startup.delete(name);
    let startupText = "";
    for (const name of startup) startupText += readFileSync(join(dir, name), "utf8");
    if (startupText.includes("src/runtime/traits/") || text.includes("src/runtime/traits/")) {
      problems.push("size: app fixture kept okmodel/traits");
    }
    if (startupText.includes("src/runtime/tenancy/") || text.includes("src/runtime/tenancy/")) {
      problems.push("size: app fixture kept okmodel/tenancy");
    }
    if (startupText.includes(" = now()")) {
      problems.push("size: app fixture kept trait clock code");
    }
    if (startupText.includes("src/runtime/archive.ts")) {
      problems.push("size: app fixture kept archive execution on the startup graph");
    }
    if (text.includes("integer_range")) {
      problems.push("size: app fixture kept the validation engine in the total graph");
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

/** Minified contribution of each input, from a bun metafile. */
type InputBytes = {
  readonly total: number;
  readonly files: ReadonlyMap<string, number>;
};

/**
 * Minifies `entry` and reads each input's bytes in the output.
 *
 * @param root - Repository root
 * @param entry - Source entry, relative to `root`
 * @param external - Packages left outside the bundle
 * @returns Per-file minified bytes
 */
export function bundleInputBytes(
  root: string,
  entry: string,
  external: readonly string[] = [],
): InputBytes {
  const dir = mkdtempSync(join(tmpdir(), "okm-meta-"));
  const meta = join(dir, "meta.json");
  try {
    const proc = Bun.spawnSync(
      [
        "bun",
        "build",
        join(root, entry),
        "--target",
        "node",
        "--minify",
        "--outdir",
        dir,
        `--metafile=${meta}`,
        ...external.flatMap((name) => ["--external", name]),
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      throw new Error(
        `bun build ${entry} exited ${String(proc.exitCode)}\n${proc.stderr.toString()}`,
      );
    }
    const graph = JSON.parse(readFileSync(meta, "utf8")) as {
      outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>;
    };
    const files = new Map<string, number>();
    let total = 0;
    for (const output of Object.values(graph.outputs)) {
      for (const [file, info] of Object.entries(output.inputs)) {
        const key = file.startsWith(root) ? file.slice(root.length + 1) : file;
        const bytes = info.bytesInOutput;
        files.set(key, (files.get(key) ?? 0) + bytes);
        total += bytes;
      }
    }
    return { total, files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Bytes in `adapter` whose source file is not in `runtime`.
 *
 * Shared modules are in both graphs. Counting them again is what a standalone
 * adapter bundle does.
 *
 * @param adapter - Adapter bundle inputs
 * @param runtime - Runtime entry inputs
 * @returns Minified bytes unique to the adapter
 */
export function incrementalMinBytes(adapter: InputBytes, runtime: InputBytes): number {
  let unique = 0;
  for (const [file, bytes] of adapter.files) {
    if (!runtime.files.has(file)) unique += bytes;
  }
  return unique;
}

/**
 * Fails when an adapter's unique minified bytes exceed its ceiling.
 *
 * @param entry - Adapter source entry
 * @param incremental - Bytes not in the runtime entry
 * @param maxBytes - Ceiling
 * @returns Problem lines. Empty when the adapter is inside the ceiling
 */
export function incrementalBudgetProblems(
  entry: string,
  incremental: number,
  maxBytes: number,
): readonly string[] {
  if (incremental <= maxBytes) return [];
  return [
    `size: ${entry} adds ${String(incremental)} minified bytes over the runtime entry, above ${String(maxBytes)}`,
  ];
}

/**
 * Fails when importing one export keeps an unrelated module.
 *
 * The default list is the `okmodel/pg` barrel. A caller can pass a barrel
 * that re-exports everything to show the check fails.
 *
 * @param root - Repository root, or the directory that holds the modules
 * @param items - Exports to import. Defaults to the Postgres barrel
 * @returns Problem lines. Empty when each export shakes
 */
export function exportShakeProblems(
  root: string,
  items: readonly ExportShake[] = EXPORT_SHAKES,
): readonly string[] {
  const problems: string[] = [];
  for (const item of items) {
    const dir = mkdtempSync(join(root, "node_modules", ".okm-shake-"));
    const entry = join(dir, "entry.ts");
    const from = item.from.startsWith("/") ? item.from : join(root, item.from);
    try {
      writeFileSync(
        entry,
        `import { ${item.name} } from ${JSON.stringify(from)};\nexport const keep = ${item.use ?? item.name};\n`,
      );
      const proc = Bun.spawnSync(
        ["bun", "build", entry, "--target", "node", "--outdir", dir, "--external", "postgres"],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      if (proc.exitCode !== 0) {
        problems.push(`size: export shake build exited ${String(proc.exitCode)}`);
        continue;
      }
      let text = "";
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".js")) continue;
        text += readFileSync(join(dir, name), "utf8");
      }
      if (!text.includes(item.keep)) {
        problems.push(`size: export shake dropped ${item.keep}`);
      }
      for (const banned of item.drop) {
        if (text.includes(banned)) problems.push(`size: export shake kept ${banned}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return problems;
}

/**
 * Replaces `specifier` in every built file, then imports `file`.
 *
 * @param dir - Bundle directory
 * @param file - Entry to import
 * @param specifier - Driver package the bundle imports
 * @returns Median of five imports, in milliseconds
 */
function stubbedImport(dir: string, file: string, specifier: string): number {
  const stub = join(dir, "okm-driver-stub.mjs");
  writeFileSync(
    stub,
    "export default function driver() { return {}; }\nexport class PostgresError extends Error {}\nexport class PGlite {}\nexport class Pool {}\nexport class SQL {}\n",
  );
  const href = JSON.stringify(pathToFileURL(stub).href);
  rewriteSpecifier(dir, specifier, href);
  return coldImportMsOnNode(file);
}

function rewriteSpecifier(dir: string, specifier: string, href: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      rewriteSpecifier(path, specifier, href);
      continue;
    }
    if (!name.endsWith(".js")) continue;
    const source = readFileSync(path, "utf8");
    const rewritten = source
      .replaceAll(`from"${specifier}"`, `from${href}`)
      .replaceAll(`from "${specifier}"`, `from${href}`);
    if (rewritten !== source) writeFileSync(path, rewritten);
  }
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

function printStubbed(measured: StartupMeasurement, ci: boolean): void {
  if (measured.stubbedColdImportMs === undefined) return;
  console.log(
    `size: ${measured.entry} driver stubbed cold import ${measured.stubbedColdImportMs.toFixed(3)} ms (local reference ${String(LOCAL_COLD_IMPORT_MS)} ms, not gated)`,
  );
  if (ci) return;
  const finding = coldImportFinding(measured.stubbedColdImportMs);
  if (finding !== undefined) console.log(`size: finding: ${measured.entry} stubbed ${finding}`);
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
    console.log(`${formatEntry(pg, ci)} (reported, not gated)`);
    const runtimeInputs = bundleInputBytes(root, RUNTIME_ENTRY);
    for (const entry of ADAPTER_ENTRIES) {
      const adapter = measureEntry(root, entry.entry, entry.external);
      const incremental = incrementalMinBytes(
        bundleInputBytes(root, entry.entry, entry.external),
        runtimeInputs,
      );
      console.log(formatEntry(adapter, ci));
      console.log(
        `size: ${entry.entry} incremental min ${String(incremental)} bytes over the runtime entry (gate ${String(entry.maxIncrementalMinBytes)})`,
      );
      problems.push(
        ...incrementalBudgetProblems(entry.entry, incremental, entry.maxIncrementalMinBytes),
      );
    }
    const app = measureStartup(root, APP_ENTRY, "app-startup.js", ["postgres"], "postgres");
    console.log(formatEntry(app, ci));
    console.log(formatTotal(app));
    const archivable = measureStartup(
      root,
      ARCHIVABLE_ENTRY,
      "app-archivable.js",
      ["postgres"],
      "postgres",
    );
    console.log(`${formatEntry(archivable, ci)} (archivable app, reported, not gated)`);
    console.log(formatTotal(archivable));
    const validating = measureStartup(
      root,
      VALIDATE_ENTRY,
      "app-validate.js",
      ["postgres"],
      "postgres",
    );
    console.log(`${formatEntry(validating, ci)} (validating app, reported, not gated)`);
    console.log(formatTotal(validating));
    const relating = measureStartup(
      root,
      RELATIONS_ENTRY,
      "app-relations.js",
      ["postgres"],
      "postgres",
    );
    console.log(`${formatEntry(relating, ci)} (relations app, reported, not gated)`);
    console.log(formatTotal(relating));
    printStubbed(app, ci);
    problems.push(...appBudgetProblems(app));
    printColdImportFinding(app, ci);
    problems.push(...shakenOperatorProblems(root));
    problems.push(...exportShakeProblems(root));
    problems.push(...printQueryLatency(root));
    for (const entry of CONNECT_ENTRIES) {
      const nodeImport = !("nodeColdImport" in entry) || entry.nodeColdImport !== false;
      const measured = measureStartup(
        root,
        entry.entry,
        entry.file,
        entry.external,
        entry.external[0],
        nodeImport,
      );
      if (nodeImport) console.log(formatEntry(measured, ci));
      else {
        console.log(
          `size: ${measured.entry} min ${String(measured.minBytes)} bytes, gzip ${String(measured.gzipBytes)} bytes (Node cold import skipped: Bun.sql runs only on Bun)`,
        );
      }
      console.log(formatTotal(measured));
      printStubbed(measured, ci);
      if ("maxMinBytes" in entry && "maxGzipBytes" in entry) {
        problems.push(
          ...entryBudgetProblems(measured, {
            maxMinBytes: entry.maxMinBytes,
            maxGzipBytes: entry.maxGzipBytes,
            maxColdImportMs: Number.POSITIVE_INFINITY,
          }),
        );
      }
    }
  } catch (error) {
    problems.push(`size: ${error instanceof Error ? error.message : String(error)}`);
  }
  exitOnProblems(problems);
}
