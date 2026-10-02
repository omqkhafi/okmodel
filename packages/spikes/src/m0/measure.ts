/**
 * Bundle size and import time for the M0 representative modules.
 *
 * Builds catalog + diff, the safety verifier, the router, and the driver
 * registry with `bun build --target node --minify`. Prints JSON. Does not
 * write a budget.
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { cpus, hostname, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { dlopen, FFIType } from "bun:ffi";

import { moduleSpecifiers } from "../../../../scripts/specifiers.js";

const RUNS = 20;
const F_NOCACHE = 48;

const MODULES = [
  { id: "catalog-diff", entry: "catalog-diff.ts" },
  { id: "verifier", entry: "verifier.ts" },
  { id: "router", entry: "router.ts" },
  { id: "registry", entry: "registry.ts" },
  { id: "combined", entry: "combined.ts" },
] as const;

type ModuleId = (typeof MODULES)[number]["id"];

type RuntimeName = "node" | "bun";

/** One module's sizes and import samples. */
type ModuleReport = {
  readonly id: ModuleId;
  readonly entry: string;
  readonly bytes: number;
  readonly gzipBytes: number;
  readonly brotliBytes: number;
  readonly bundleHasCryptoHasher: boolean;
  readonly npmPackages: readonly NpmPackage[];
  readonly sourceBareSpecifiers: readonly string[];
  readonly sourceFiles: readonly string[];
  readonly importMs: Record<RuntimeName, Record<"warm" | "cold", Timing>>;
};

/** An npm package the bundler wrote into the output, from the metafile. */
type NpmPackage = {
  readonly name: string;
  readonly bytesInOutput: number;
};

/** Mean and nearest-rank p95. */
type Timing = {
  readonly meanMs: number;
  readonly p95Ms: number;
  readonly samplesMs: readonly number[];
};

const libc = dlopen("libc.dylib", {
  fcntl: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
});

const entriesDir = join(import.meta.dir, "entries");
const outDir = join(import.meta.dir, "..", "..", ".m0-measure");

/**
 * Runs the measurement and prints one JSON object.
 */
function main(): void {
  mkdirSync(outDir, { recursive: true });
  try {
    const modules = MODULES.map((module) => measureModule(module.id, module.entry));
    const report = {
      command: "bun build <entry> --target node --minify",
      gzipLevel: zlibConstants.Z_BEST_COMPRESSION,
      brotliQuality: zlibConstants.BROTLI_MAX_QUALITY,
      runs: RUNS,
      p95: "nearest-rank ceil(0.95 * n) - 1",
      importTimer: "performance.now around import() in a fresh process",
      coldFile: "each run writes a new file with fcntl F_NOCACHE before the first read",
      host: hostInfo(),
      cacheProbe: probeFileCache(),
      runtimeDependencies: dependencyCheck(modules),
      modules,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * Builds one entry and times its import.
 *
 * @param id - Report name
 * @param entry - File under `entries/`
 * @returns Sizes, bundle markers, and timings
 */
function measureModule(id: ModuleId, entry: string): ModuleReport {
  const entryPath = join(entriesDir, entry);
  const outfile = join(outDir, `${id}.js`);
  const metafile = join(outDir, `${id}.meta.json`);
  const build = spawnSync(
    "bun",
    [
      "build",
      entryPath,
      "--target",
      "node",
      "--minify",
      `--outfile=${outfile}`,
      `--metafile=${metafile}`,
    ],
    { encoding: "utf8" },
  );
  if (build.status !== 0) {
    throw new Error(build.stderr || build.stdout || `build failed for ${id}`);
  }
  const bytes = readFileSync(outfile);
  const graph = sourceGraph(entryPath);
  const warmPath = join(outDir, `${id}-warm.js`);
  writeFileSync(warmPath, bytes);
  warmup(warmPath);

  return {
    id,
    entry: `packages/spikes/src/m0/entries/${entry}`,
    bytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes, { level: zlibConstants.Z_BEST_COMPRESSION }).byteLength,
    brotliBytes: brotliCompressSync(bytes, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY },
    }).byteLength,
    bundleHasCryptoHasher: bytes.includes("CryptoHasher"),
    npmPackages: npmPackagesIn(metafile),
    sourceBareSpecifiers: graph.bare,
    sourceFiles: graph.files,
    importMs: {
      node: {
        warm: timeImports("node", () => warmPath),
        cold: timeImports("node", () => coldCopy(id, bytes)),
      },
      bun: {
        warm: timeImports("bun", () => warmPath),
        cold: timeImports("bun", () => coldCopy(id, bytes)),
      },
    },
  };
}

/**
 * Reads a file and imports it once so later imports hit a warm cache.
 *
 * @param path - Bundle path
 */
function warmup(path: string): void {
  readFileSync(path);
  importOnce("bun", path);
  importOnce("node", path);
}

let coldSeq = 0;

/**
 * Writes a bundle to a new path with caching disabled on the write.
 *
 * @param id - Module id, used in the file name
 * @param bytes - Minified source
 * @returns The new path
 */
function coldCopy(id: ModuleId, bytes: Buffer): string {
  coldSeq += 1;
  const path = join(outDir, `${id}-cold-${String(coldSeq)}.js`);
  const fd = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY,
    0o644,
  );
  const set = libc.symbols.fcntl(fd, F_NOCACHE, 1);
  if (set !== 0) {
    closeSync(fd);
    throw new Error(`fcntl F_NOCACHE returned ${String(set)} for ${path}`);
  }
  writeSync(fd, bytes);
  closeSync(fd);
  return path;
}

/**
 * Times {@link RUNS} fresh-process imports.
 *
 * @param runtime - `node` or `bun`
 * @param pathForRun - Path to import. Called once per run
 * @returns Mean, p95, and the samples
 */
function timeImports(runtime: RuntimeName, pathForRun: () => string): Timing {
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    samples.push(importOnce(runtime, pathForRun()));
  }
  return summarize(samples);
}

/**
 * Imports a bundle in a new process and returns the in-process duration.
 *
 * @param runtime - `node` or `bun`
 * @param path - JavaScript file
 * @returns Milliseconds
 */
function importOnce(runtime: RuntimeName, path: string): number {
  const href = pathToFileURL(path).href;
  const code = `const s=performance.now();await import(${JSON.stringify(href)});process.stdout.write(String(performance.now()-s));`;
  const args = runtime === "node" ? ["--input-type=module", "-e", code] : ["-e", code];
  const result = spawnSync(runtime, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${runtime} import failed for ${path}\n${result.stderr || result.stdout}`);
  }
  const ms = Number(result.stdout);
  if (!Number.isFinite(ms)) {
    throw new Error(`${runtime} import returned '${result.stdout}' for ${path}`);
  }
  return ms;
}

/**
 * Mean and nearest-rank p95.
 *
 * @param samples - Durations in milliseconds
 * @returns Rounded mean and p95, plus the raw samples
 */
function summarize(samples: readonly number[]): Timing {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const index = Math.ceil(0.95 * sorted.length) - 1;
  const p95 = sorted[index] ?? mean;
  return {
    meanMs: roundMs(mean),
    p95Ms: roundMs(p95),
    samplesMs: samples.map(roundMs),
  };
}

/**
 * Rounds a duration to microseconds.
 *
 * @param ms - Milliseconds
 * @returns Rounded milliseconds
 */
function roundMs(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/**
 * Walks relative imports from an entry and records bare specifiers.
 *
 * @param entry - TypeScript entry
 * @returns Source files and bare module names
 */
function sourceGraph(entry: string): {
  readonly files: readonly string[];
  readonly bare: readonly string[];
} {
  const files: string[] = [];
  const bare = new Set<string>();
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    files.push(relativeToRepo(file));
    for (const spec of moduleSpecifiers(readFileSync(file, "utf8"), file)) {
      if (spec.startsWith(".")) {
        pending.push(resolveRelative(file, spec));
        continue;
      }
      bare.add(spec);
    }
  }
  files.sort();
  return { files, bare: [...bare].sort() };
}

/**
 * Resolves a relative specifier to a source file.
 *
 * @param from - Importing file
 * @param spec - Relative specifier ending in `.js`
 * @returns Existing file path
 */
function resolveRelative(from: string, spec: string): string {
  const target = resolve(dirname(from), spec);
  const candidates = [target, target.replace(/\.js$/, ".ts"), target.replace(/\.js$/, ".tsx")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  throw new Error(`Cannot resolve ${spec} from ${from}`);
}

/**
 * Npm packages attributed in a bun metafile, largest first.
 *
 * @param metafile - Path written by `--metafile`
 * @returns Packages under `node_modules` and the bytes bun attributed to them
 */
function npmPackagesIn(metafile: string): readonly NpmPackage[] {
  const parsed: unknown = JSON.parse(readFileSync(metafile, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.outputs)) {
    throw new Error(`${metafile} has no outputs`);
  }
  const totals = new Map<string, number>();
  for (const output of Object.values(parsed.outputs)) {
    if (!isRecord(output) || !isRecord(output.inputs)) {
      continue;
    }
    for (const [path, info] of Object.entries(output.inputs)) {
      const name = npmName(path);
      if (name === undefined || !isRecord(info)) {
        continue;
      }
      const bytes = info.bytesInOutput;
      if (typeof bytes !== "number") {
        continue;
      }
      totals.set(name, (totals.get(name) ?? 0) + bytes);
    }
  }
  return [...totals.entries()]
    .map(([name, bytesInOutput]) => ({ name, bytesInOutput }))
    .sort((a, b) => b.bytesInOutput - a.bytesInOutput || a.name.localeCompare(b.name));
}

/**
 * Package name for a metafile input, when the file lives in `node_modules`.
 *
 * @param path - Input path from the metafile
 * @returns The package, or undefined for a workspace file
 */
function npmName(path: string): string | undefined {
  const parts = path.split("node_modules/");
  const last = parts.at(-1);
  if (last === undefined || parts.length < 2) {
    return undefined;
  }
  if (last.startsWith("@")) {
    const [scope, name] = last.split("/");
    if (scope !== undefined && name !== undefined && name.length > 0) {
      return `${scope}/${name}`;
    }
    return undefined;
  }
  const name = last.split("/")[0];
  return name === undefined || name.length === 0 ? undefined : name;
}

/**
 * Says whether any measured module imports an npm runtime dependency.
 *
 * A workspace package with no `dependencies` of its own is recorded, and so
 * are `postgres` and `@electric-sql/pglite` if they appear in the bundle.
 *
 * @param modules - Finished module reports
 * @returns The check result
 */
function dependencyCheck(modules: readonly ModuleReport[]): {
  readonly ok: boolean;
  readonly notes: readonly string[];
} {
  const notes: string[] = [];
  let ok = true;
  for (const module of modules) {
    const runtime = module.sourceBareSpecifiers.filter((spec) => !spec.startsWith("node:"));
    if (runtime.length > 0) {
      notes.push(`${module.id} source imports ${runtime.join(", ")}`);
    }
    if (module.npmPackages.length > 0) {
      ok = false;
      const listed = module.npmPackages
        .map((pkg) => `${pkg.name} (${String(pkg.bytesInOutput)} bytes)`)
        .join(", ");
      notes.push(`${module.id} bundle contains ${listed}`);
    }
  }
  const spikes = packageDeps(join(import.meta.dir, "..", "..", "package.json"));
  const harness = packageDeps(join(import.meta.dir, "..", "..", "..", "harness", "package.json"));
  notes.push(`@okmodel/spikes dependencies: ${spikes.dependencies.join(", ") || "(none)"}`);
  notes.push(`@okmodel/spikes devDependencies: ${spikes.devDependencies.join(", ") || "(none)"}`);
  notes.push(`@okmodel/harness dependencies: ${harness.dependencies.join(", ") || "(none)"}`);
  notes.push(`@okmodel/harness devDependencies: ${harness.devDependencies.join(", ") || "(none)"}`);
  if (modules.some((module) => module.bundleHasCryptoHasher)) {
    notes.push("catalog bundle calls Bun.CryptoHasher; import does not load an npm package");
  }
  notes.unshift(
    ok ? "no measured bundle includes an npm package" : "a measured bundle includes an npm package",
  );
  return { ok, notes };
}

/**
 * Reads dependency names from a package.json.
 *
 * @param path - package.json path
 * @returns Runtime and development dependency names
 */
function packageDeps(path: string): {
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
} {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`${path} is not an object`);
  }
  return {
    dependencies: names(parsed.dependencies),
    devDependencies: names(parsed.devDependencies),
  };
}

/**
 * Keys of a dependency map.
 *
 * @param value - JSON value
 * @returns Sorted names
 */
function names(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.keys(value).sort();
}

/**
 * Host, runtime, and compiler versions for the report.
 *
 * @returns Machine description
 */
function hostInfo(): {
  readonly hostname: string;
  readonly os: string;
  readonly cpu: string;
  readonly memoryBytes: number;
  readonly node: string;
  readonly bun: string;
  readonly typescript: string;
} {
  const tsc = spawnSync("bunx", ["tsc", "--version"], { encoding: "utf8" });
  const node = spawnSync("node", ["-v"], { encoding: "utf8" });
  const cpu = cpus()[0]?.model ?? platform();
  return {
    hostname: hostname(),
    os: `${platform()} ${release()} ${process.arch}`,
    cpu,
    memoryBytes: totalmem(),
    node: (node.stdout || node.stderr).trim(),
    bun: Bun.version,
    typescript: (tsc.stdout || tsc.stderr).trim(),
  };
}

/**
 * Times a first and second read of an 8 MiB file written with `F_NOCACHE`.
 *
 * This checks that the cold-file method misses the cache. It is not an import time.
 *
 * @returns Both read durations
 */
function probeFileCache(): { readonly firstReadMs: number; readonly secondReadMs: number } {
  const path = join(outDir, "cache-probe.bin");
  const bytes = Buffer.alloc(8 * 1024 * 1024, 1);
  const fd = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY,
    0o644,
  );
  const set = libc.symbols.fcntl(fd, F_NOCACHE, 1);
  if (set !== 0) {
    closeSync(fd);
    throw new Error(`fcntl F_NOCACHE returned ${String(set)} for the cache probe`);
  }
  writeSync(fd, bytes);
  closeSync(fd);
  const first = timeRead(path);
  const second = timeRead(path);
  return { firstReadMs: roundMs(first), secondReadMs: roundMs(second) };
}

/**
 * Times one full read in a fresh Bun process.
 *
 * @param path - File to read
 * @returns Milliseconds
 */
function timeRead(path: string): number {
  const code = `const s=performance.now();await Bun.file(${JSON.stringify(path)}).arrayBuffer();process.stdout.write(String(performance.now()-s));`;
  const result = spawnSync("bun", ["-e", code], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || "cache probe read failed");
  }
  const ms = Number(result.stdout);
  if (!Number.isFinite(ms)) {
    throw new Error(`cache probe returned '${result.stdout}'`);
  }
  return ms;
}

/**
 * Path relative to the repository root.
 *
 * @param path - Absolute path
 * @returns Repo-relative path
 */
function relativeToRepo(path: string): string {
  const root = resolve(import.meta.dir, "..", "..", "..", "..");
  return path.startsWith(root) ? path.slice(root.length + 1) : path;
}

/**
 * Narrows a JSON value to a record.
 *
 * @param value - Parsed JSON
 * @returns Whether it is a non-null object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  main();
}
