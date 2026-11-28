import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

/** Tree-shaken 10-table app. D133. Byte size is reported. It is not a gate. */
export const APP_ENTRY = "scripts/app-startup.ts";

/** The same app with `archivable()` on one table. Reported, not gated (D167). */
export const ARCHIVABLE_ENTRY = "scripts/app-archivable.ts";

/** The same app with validation on. Reported, not gated. */
export const VALIDATE_ENTRY = "scripts/app-validate.ts";

/** The same app using `manyThrough`, `page` and `aggregate`. Reported, not gated (D176). */
export const RELATIONS_ENTRY = "scripts/app-relations.ts";

/**
 * The same app with every 0.2 feature in use: tenancy, archivable, validation,
 * relations, presets, `tx` and `batch`. Reported, not gated (P30).
 */
export const FULL_ENTRY = "scripts/app-full.ts";

/**
 * Public connect entries, driver left external (D142, D143, D156).
 *
 * The reported graph is the static startup graph with lazy dynamic imports
 * stubbed (D248). A dynamic import of a module already on that graph stays,
 * because a cold import loads it. Bun.sql has no Node cold import.
 */
export const CONNECT_ENTRIES = [
  {
    entry: "src/runtime/pg/postgresjs.ts",
    file: "postgresjs.js",
    external: ["postgres"],
  },
  {
    entry: "src/runtime/pg/pglite.ts",
    file: "pglite.js",
    external: ["@electric-sql/pglite"],
  },
  {
    entry: "src/runtime/pg/pg.ts",
    file: "pg.js",
    external: ["pg"],
  },
  {
    entry: "src/runtime/pg/bun.ts",
    file: "bun.js",
    external: ["bun"],
    nodeColdImport: false,
  },
  {
    entry: "src/runtime/pg/neon.ts",
    file: "neon.js",
    external: ["@neondatabase/serverless"],
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
  "lane",
  "matches",
  "relevance",
  "json-set",
  "json-ns",
  "arr-append",
  "arr-remove",
  "arr-ns",
] as const;

/**
 * Adapter entries.
 *
 * Reported bytes are the minified bytes that are not already in the runtime
 * entry. A standalone bundle counts that shared code again (D135).
 */
export const ADAPTER_ENTRIES = [
  {
    entry: "src/adapters/pg/postgresjs.ts",
    external: ["postgres"],
  },
  {
    entry: "src/adapters/pg/pglite.ts",
    external: ["@electric-sql/pglite"],
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
    drop: [
      "src/dialects/pg/ops/lt.ts",
      "src/dialects/pg/ops/gt.ts",
      "src/dialects/pg/ops/like.ts",
      "src/dialects/pg/ops/bucket.ts",
    ],
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

/**
 * Byte size of every file under `dir`.
 *
 * @param dir - Directory to walk
 * @returns Sum of file sizes in bytes
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

/** Byte and import measurements for one entry. */
export type RuntimeSize = {
  readonly entry: string;
  readonly minBytes: number;
  readonly gzipBytes: number;
  readonly coldImportMs: number;
};

/**
 * Startup graph plus the lazy chunks that load on first include, failure, or write.
 *
 * The startup figure is {@link RuntimeSize}. The total includes lazy chunks (D138).
 */
export type StartupMeasurement = RuntimeSize & {
  readonly totalMinBytes: number;
  readonly totalGzipBytes: number;
  /** Cold import after the driver package is replaced with an empty module. */
  readonly stubbedColdImportMs?: number;
};

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
 * @param coldSamples - Fresh Node imports. Zero skips the import. The report uses 10
 * @returns Sizes and the cold-import sample
 */
export function measureEntry(
  root: string,
  entry: string,
  external: readonly string[] = [],
  coldSamples: number = COLD_IMPORT_SAMPLES,
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
    const coldImportMs = coldImportMsOnNode(outfile, coldSamples);
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

const CHUNK_FILE = /^(.+)-([a-z0-9]{8})\.js$/;

/**
 * Replaces content-hash chunk ids with a fixed id of the same length.
 *
 * Minified size counts the real files. Gzip uses this copy, so a lazy chunk
 * whose only change is its id does not move the number.
 *
 * @param dir - Build output that holds the chunk files
 * @param bytes - Startup or total graph, concatenated
 * @returns The same bytes with chunk ids normalised
 */
function normaliseChunkIds(dir: string, bytes: Buffer): Buffer {
  const pairs: { readonly from: string; readonly to: string }[] = [];
  for (const name of readdirSync(dir)) {
    const match = CHUNK_FILE.exec(name);
    const stem = match?.[1];
    const hash = match?.[2];
    if (stem === undefined || hash === undefined) continue;
    pairs.push({ from: name, to: `${stem}-${"0".repeat(hash.length)}.js` });
  }
  pairs.sort((left, right) => right.from.length - left.from.length);
  let text = bytes.toString("utf8");
  for (const pair of pairs) text = text.replaceAll(pair.from, pair.to);
  return Buffer.from(text);
}

const staticImport = /from\s*"(\.\/[^"]+)"/g;
const dynamicImport = /import\s*\(\s*"(\.\/[^"]+)"\s*\)/g;
const sideEffectImport = /import\s*"(\.\/[^"]+)"/g;

/**
 * Minifies an entry with splitting and counts only the static-import graph.
 *
 * This is the full build. Lazy chunks are not added into the byte total, but
 * they still share the minifier, so their names change this number (D247).
 * {@link measureStubbedStartup} is the startup figure. This result is the reference.
 * Gzip is the concatenation of the startup chunks.
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
    const sizes = readStartupBytes(dir, file);
    const outfile = join(dir, file);
    const coldImportMs = nodeImport ? coldImportMsOnNode(outfile) : 0;
    const stubbedColdImportMs =
      stubSpecifier === undefined ? undefined : stubbedImport(dir, outfile, stubSpecifier);
    return {
      entry,
      ...sizes,
      coldImportMs,
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

/** Minified and gzip bytes of one splitting build. */
type GraphBytes = {
  readonly minBytes: number;
  readonly gzipBytes: number;
  readonly totalMinBytes: number;
  readonly totalGzipBytes: number;
};

/**
 * Chunk files a cold import of `file` loads.
 *
 * Dynamic `import()` targets are not included. `file` is the built entry name.
 *
 * The order is the walk order. Gzip concatenates these chunks, so sorting them
 * would change the gated number without a source change.
 *
 * @param dir - Build output
 * @param file - Built entry filename
 * @returns Startup chunk names, entry first
 */
export function startupChunkNames(dir: string, file: string): readonly string[] {
  const startup = new Set<string>();
  const lazy = new Set<string>();
  walkStartup(dir, file, startup, lazy);
  for (const name of lazy) startup.delete(name);
  return [...startup];
}

/**
 * Byte size of the startup chunks and of the whole build.
 *
 * @param dir - Build output
 * @param file - Built entry filename
 * @returns Startup bytes and the total graph, lazy chunks included in the total only
 */
function readStartupBytes(
  dir: string,
  file: string,
  startup: readonly string[] = startupChunkNames(dir, file),
): GraphBytes {
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
  return {
    minBytes,
    gzipBytes: gzipSync(normaliseChunkIds(dir, Buffer.concat(parts)), { level: 9 }).byteLength,
    totalMinBytes,
    totalGzipBytes: gzipSync(normaliseChunkIds(dir, Buffer.concat(totalParts)), { level: 9 })
      .byteLength,
  };
}

/**
 * Static startup graph with every relative dynamic import replaced by an empty module.
 *
 * Cold import is not measured. {@link measureStartup} times the full build.
 */
export type StubbedStartup = RuntimeSize & {
  /** Source files in the stubbed graph, relative to the repository root. */
  readonly sources: readonly string[];
};

const LAZY_STUB = "lazy-stub";

/**
 * Empties relative dynamic `import()`s of modules a cold import does not load.
 *
 * One plugin covers every target. A stub file per target would need a list of
 * those targets first. `bun build` has no plugin flag, so the gated build uses
 * `Bun.build`. The stub key is the importer plus the specifier: `build.resolve`
 * is not implemented, and the specifier alone would merge `./batch.js` from two
 * directories into one chunk.
 *
 * A dynamic import of a module already in {@link startupKeep} stays. Stubbing
 * that edge lets the tree-shaker drop a static import the shared startup chunk
 * keeps. `DriverError` pulls `error.ts` onto every connect entry, so a dynamic
 * import of that same module stays. The failure mapper loads `connection.ts`
 * from `lazy-errors.ts`, which is not on this graph, and that import is stubbed.
 *
 * @param keep - Real paths of modules in the unstubbed startup graph
 * @returns The plugin passed to `Bun.build`
 */
function stubDynamicPlugin(keep: ReadonlySet<string>): Bun.BunPlugin {
  return {
    name: "stub-dynamic-imports",
    setup(build) {
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (args.kind !== "dynamic-import" || args.namespace === LAZY_STUB) return;
        const resolved = resolveStartupModule(args.importer, args.path);
        if (resolved !== undefined && keep.has(resolved)) return;
        return { path: `${args.importer}\0${args.path}`, namespace: LAZY_STUB };
      });
      build.onLoad({ filter: /.*/, namespace: LAZY_STUB }, () => ({
        contents: "",
        loader: "js",
      }));
    },
  };
}

/**
 * Resolves a relative specifier to a source file.
 *
 * Published imports use `.js`. The file on disk is the TypeScript source.
 * A missing file is left for the bundler to report.
 *
 * @param importer - File that contains the import
 * @param specifier - Relative specifier
 * @returns Absolute real path, or `undefined` when nothing is there
 */
function resolveStartupModule(importer: string, specifier: string): string | undefined {
  const base = resolve(dirname(importer), specifier);
  const noExt = base.replace(/\.(js|ts|tsx)$/, "");
  const candidates = [base, `${noExt}.ts`, `${noExt}.tsx`, join(noExt, "index.ts")];
  for (const candidate of candidates) {
    try {
      return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Real paths of the modules a cold import loads.
 *
 * @param root - Repository root
 * @param entry - Source entry, relative to `root`
 * @param file - Built entry filename
 * @param external - Packages left outside the bundle
 * @returns Absolute paths from the unstubbed startup graph
 */
async function startupKeep(
  root: string,
  entry: string,
  file: string,
  external: readonly string[],
): Promise<ReadonlySet<string>> {
  const sources = await startupGraphSources(root, entry, file, external, false);
  const keep = new Set<string>();
  for (const source of sources) {
    const candidate = isAbsolute(source) ? source : join(root, source);
    try {
      keep.add(realpathSync(candidate));
    } catch {
      continue;
    }
  }
  return keep;
}

/**
 * The dynamic-import stub for one startup entry.
 *
 * Same plugin as {@link measureStubbedStartup}. The attribution build must
 * call this so its bytes stay the gated bytes.
 *
 * @param root - Repository root
 * @param entry - Source entry, relative to `root`
 * @param file - Built entry filename
 * @param external - Packages left outside the bundle
 * @returns The plugin passed to `Bun.build`
 */
export async function startupStubPlugin(
  root: string,
  entry: string,
  file: string,
  external: readonly string[] = [],
): Promise<Bun.BunPlugin> {
  return stubDynamicPlugin(await startupKeep(root, entry, file, external));
}

/** One bundler metafile, the fields this script reads. */
type SizeMetafile = {
  readonly outputs: Readonly<
    Record<string, { readonly inputs?: Readonly<Record<string, unknown>> }>
  >;
};

/**
 * A metafile input as a path relative to `root`.
 *
 * The bundler writes paths relative to its cwd. `Bun.build` uses this process.
 * `bun build` uses `root`.
 *
 * @param input - Metafile input path
 * @param root - Directory the entry was built from
 * @returns A path under `root`, or the absolute path when it is outside
 */
function sourcePath(input: string, root: string): string {
  const base = realpathSync(root);
  const candidates = isAbsolute(input) ? [input] : [resolve(input), resolve(base, input)];
  for (const candidate of candidates) {
    let target = candidate;
    try {
      target = realpathSync(candidate);
    } catch {
      continue;
    }
    const rel = relative(base, target);
    if (!rel.startsWith("..")) return rel;
  }
  return input;
}

/**
 * Source files that contributed to the startup chunks.
 *
 * @param meta - Bundler metafile
 * @param root - Repository root
 * @param dir - Build output
 * @param startup - Chunk names from {@link startupChunkNames}
 * @returns Paths relative to `root`, sorted
 */
function sourcesInStartup(
  meta: SizeMetafile,
  root: string,
  dir: string,
  startup: ReadonlySet<string>,
): readonly string[] {
  const dirPrefix = dir.endsWith("/") ? dir : `${dir}/`;
  const sources = new Set<string>();
  for (const [outPath, output] of Object.entries(meta.outputs)) {
    const name = outPath.startsWith(dirPrefix)
      ? outPath.slice(dirPrefix.length)
      : outPath.slice(outPath.lastIndexOf("/") + 1);
    if (!startup.has(name)) continue;
    for (const input of Object.keys(output.inputs ?? {})) {
      if (input.includes("\0")) continue;
      sources.add(sourcePath(input, root));
    }
  }
  return [...sources].sort();
}

/**
 * Minifies the static startup graph with lazy dynamic imports stubbed.
 *
 * The modules are the ones a cold start loads. A dynamic import of a module
 * already in that set is not stubbed ({@link startupStubPlugin}). Empty lazy
 * targets share nothing, so the shared startup chunk is inlined. Adding or
 * removing a lazy chunk does not move the number (D248). The runtime entry
 * has no dynamic import, and an `onResolve` hook changes mangling even when it
 * stubs nothing, so that entry stays on {@link measureEntry}.
 *
 * @param root - Repository root
 * @param entry - Source entry, relative to `root`
 * @param file - Built entry filename
 * @param external - Packages left outside the bundle
 * @returns Gated bytes. `coldImportMs` is 0; time the full build instead
 */
export async function measureStubbedStartup(
  root: string,
  entry: string,
  file: string,
  external: readonly string[] = [],
): Promise<StubbedStartup> {
  const parent = external.length > 0 ? join(root, "node_modules") : tmpdir();
  const dir = mkdtempSync(join(parent, external.length > 0 ? ".okm-size-" : "okm-size-"));
  try {
    const result = await Bun.build({
      entrypoints: [join(root, entry)],
      target: "node",
      minify: true,
      splitting: true,
      outdir: dir,
      external: [...external],
      metafile: true,
      plugins: [await startupStubPlugin(root, entry, file, external)],
    });
    if (!result.success) {
      const message = result.logs.map((log) => log.message).join("\n");
      throw new Error(`bun build ${entry} exited\n${message}`);
    }
    const startup = startupChunkNames(dir, file);
    const sizes = readStartupBytes(dir, file, startup);
    const sources = sourcesInStartup(result.metafile as SizeMetafile, root, dir, new Set(startup));
    return { entry, ...sizes, coldImportMs: 0, sources };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Source files in the static startup graph, relative to `root`, sorted.
 *
 * The full build is the `bun build` the cold import loads. The stubbed build
 * is {@link measureStubbedStartup}. Dynamic imports of modules outside that
 * graph are omitted from both.
 *
 * @param root - Repository root
 * @param entry - Source entry, relative to `root`
 * @param file - Built entry filename
 * @param external - Packages left outside the bundle
 * @param stubDynamic - When true, replace relative dynamic imports with empty modules
 * @returns Source paths in the startup chunks
 */
export async function startupGraphSources(
  root: string,
  entry: string,
  file: string,
  external: readonly string[] = [],
  stubDynamic = false,
): Promise<readonly string[]> {
  if (stubDynamic) {
    return (await measureStubbedStartup(root, entry, file, external)).sources;
  }
  const parent = external.length > 0 ? join(root, "node_modules") : tmpdir();
  const dir = mkdtempSync(join(parent, external.length > 0 ? ".okm-size-" : "okm-size-"));
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
        "--splitting",
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
    const graph = JSON.parse(readFileSync(meta, "utf8")) as SizeMetafile;
    return sourcesInStartup(graph, root, dir, new Set(startupChunkNames(dir, file)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Fails when the app fixture's startup graph contains an operator it does not import,
 * or the timestamps trait and its clock.
 *
 * @param root - Repository root
 * @returns Problem lines. Empty when only `eq` is present
 */
/**
 * `okmodel/session` must not load the roles config until `okmodel/session/role`.
 *
 * @param root - Repository root
 * @returns Problems, empty when the session bundle omits `role/config.ts`
 */
export function sessionRoleProblems(root: string): readonly string[] {
  const dir = mkdtempSync(join(tmpdir(), "okm-session-"));
  try {
    const proc = Bun.spawnSync(
      [
        "bun",
        "build",
        join(root, "src/runtime/session/index.ts"),
        "--target",
        "node",
        "--outdir",
        dir,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      return [`size: session build exited ${String(proc.exitCode)}`];
    }
    let text = "";
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".js")) continue;
      text += readFileSync(join(dir, name), "utf8");
    }
    if (text.includes("src/dialects/pg/role/config.ts")) {
      return ["size: okmodel/session kept the roles config"];
    }
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Modules a query does not need.
 *
 * They compile DDL. `schema()` stores descriptors and loads them on the first
 * `.catalog` read. A featureless app must not list them.
 */
export const TOOLING_ONLY_STARTUP = [
  "src/dialects/pg/exclusion.ts",
  "src/dialects/pg/catalog-compile.ts",
  "src/dialects/pg/compile.ts",
  "src/contracts/catalog/build.ts",
  "src/contracts/catalog/order.ts",
  "src/contracts/catalog/extension.ts",
  "src/contracts/catalog/object.ts",
  "src/contracts/catalog/json.ts",
  "src/contracts/catalog/identity-key.ts",
  "src/dialects/pg/composite-mark.ts",
  "src/dialects/pg/policy-slot.ts",
  "src/dialects/pg/series-slot.ts",
  "src/dialects/pg/generated-hold.ts",
  "src/dialects/pg/role/grant-slot.ts",
  "src/dialects/pg/partition-compile.ts",
  "src/dialects/pg/partition-sql.ts",
  "src/tooling/migrate/partition-cmd.ts",
  "src/tooling/migrate/partition-maintain.ts",
  "src/tooling/migrate/partition-probe.ts",
] as const;

/**
 * Fails when the featureless app's stubbed startup graph loads a DDL compiler.
 *
 * The source list is `measureStubbedStartup` (`startupGraphSources` with dynamic
 * imports stubbed). `catalog-load.ts` stays: it is the loader, not the compiler.
 * `column-mark.ts` stays: composite enum labels are read while the query model is built.
 *
 * @param root - Repository root
 * @returns Problem lines. Empty when the graph is query-only
 */
export async function featurelessCompilerProblems(root: string): Promise<readonly string[]> {
  const sources = await startupGraphSources(root, APP_ENTRY, "app-startup.js", ["postgres"], true);
  const problems: string[] = [];
  for (const banned of TOOLING_ONLY_STARTUP) {
    if (sources.includes(banned)) {
      problems.push(`size: featureless startup kept ${banned}. sources: ${sources.join(", ")}`);
    }
  }
  if (!sources.includes("src/dialects/pg/catalog-load.ts")) {
    problems.push("size: featureless startup dropped catalog-load.ts");
  }
  if (!sources.includes("src/dialects/pg/schema.ts")) {
    problems.push("size: featureless startup dropped schema.ts");
  }
  return problems;
}

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

/** How many cold imports the pull-request report takes. The median is the figure. */
export const REPORT_COLD_IMPORT_SAMPLES = 10;

function coldImportMsOnNode(file: string, samples: number = COLD_IMPORT_SAMPLES): number {
  if (samples <= 0) return 0;
  const taken: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    taken.push(oneColdImport(file));
  }
  taken.sort((left, right) => left - right);
  return taken[Math.floor(taken.length / 2)] ?? 0;
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
    "export default function driver() { return {}; }\nexport function neon() { return {}; }\nexport const neonConfig = {};\nexport class NeonDbError extends Error {}\nexport class PostgresError extends Error {}\nexport class PGlite {}\nexport class Pool {}\nexport class SQL {}\n",
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

function formatStubbed(measured: RuntimeSize): string {
  return `size: ${measured.entry} min ${String(measured.minBytes)} bytes, gzip ${String(measured.gzipBytes)} bytes (startup graph, dynamic imports stubbed)`;
}

function formatReference(measured: RuntimeSize, nodeImport: boolean): string {
  if (!nodeImport) {
    return `size: ${measured.entry} reference min ${String(measured.minBytes)} bytes, gzip ${String(measured.gzipBytes)} bytes (full build; Node cold import skipped: Bun.sql runs only on Bun)`;
  }
  return `size: ${measured.entry} reference min ${String(measured.minBytes)} bytes, gzip ${String(measured.gzipBytes)} bytes, cold import ${measured.coldImportMs.toFixed(3)} ms (full build)`;
}

function formatTotal(measured: StartupMeasurement): string {
  return `size: ${measured.entry} total graph min ${String(measured.totalMinBytes)} bytes, gzip ${String(measured.totalGzipBytes)} bytes (lazy chunks included)`;
}

function formatEntry(measured: RuntimeSize): string {
  return `size: ${measured.entry} min ${String(measured.minBytes)} bytes, gzip ${String(measured.gzipBytes)} bytes, cold import ${measured.coldImportMs.toFixed(3)} ms`;
}

function printStubbed(measured: StartupMeasurement): void {
  if (measured.stubbedColdImportMs === undefined) return;
  console.log(
    `size: ${measured.entry} driver stubbed cold import ${measured.stubbedColdImportMs.toFixed(3)} ms`,
  );
}

async function reportSize(): Promise<void> {
  const root = repoRoot();
  const dir = join(root, "dist");
  const problems: string[] = [];
  try {
    console.log(`size: dist ${String(distByteSize(dir))} bytes`);
  } catch (error) {
    problems.push(
      `size: cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const runtime = measureRuntimeEntry(root);
    console.log(formatEntry(runtime));
    const pg = measureEntry(root, PG_ENTRY);
    console.log(`${formatEntry(pg)} (okmodel/pg)`);
    const runtimeInputs = bundleInputBytes(root, RUNTIME_ENTRY);
    for (const entry of ADAPTER_ENTRIES) {
      const adapter = measureEntry(root, entry.entry, entry.external);
      const incremental = incrementalMinBytes(
        bundleInputBytes(root, entry.entry, entry.external),
        runtimeInputs,
      );
      console.log(formatEntry(adapter));
      console.log(
        `size: ${entry.entry} incremental min ${String(incremental)} bytes over the runtime entry`,
      );
    }
    const app = measureStartup(root, APP_ENTRY, "app-startup.js", ["postgres"], "postgres");
    const appStubbed = await measureStubbedStartup(root, APP_ENTRY, "app-startup.js", ["postgres"]);
    console.log(formatStubbed(appStubbed));
    console.log(formatReference(app, true));
    console.log(formatTotal(app));
    const archivable = measureStartup(
      root,
      ARCHIVABLE_ENTRY,
      "app-archivable.js",
      ["postgres"],
      "postgres",
    );
    console.log(`${formatEntry(archivable)} (archivable app)`);
    console.log(formatTotal(archivable));
    const validating = measureStartup(
      root,
      VALIDATE_ENTRY,
      "app-validate.js",
      ["postgres"],
      "postgres",
    );
    console.log(`${formatEntry(validating)} (validating app)`);
    console.log(formatTotal(validating));
    const relating = measureStartup(
      root,
      RELATIONS_ENTRY,
      "app-relations.js",
      ["postgres"],
      "postgres",
    );
    console.log(`${formatEntry(relating)} (relations app)`);
    console.log(formatTotal(relating));
    const full = measureStartup(root, FULL_ENTRY, "app-full.js", ["postgres"], "postgres");
    console.log(`${formatEntry(full)} (feature-full app)`);
    console.log(formatTotal(full));
    const testingEntry = measureEntry(root, "src/tooling/testing/index.ts");
    console.log(`${formatEntry(testingEntry)} (okmodel/testing)`);
    printStubbed(app);
    problems.push(...(await featurelessCompilerProblems(root)));
    problems.push(...shakenOperatorProblems(root));
    problems.push(...sessionRoleProblems(root));
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
      const stubbed = await measureStubbedStartup(root, entry.entry, entry.file, entry.external);
      console.log(formatStubbed(stubbed));
      console.log(formatReference(measured, nodeImport));
      console.log(formatTotal(measured));
      printStubbed(measured);
    }
  } catch (error) {
    problems.push(`size: ${error instanceof Error ? error.message : String(error)}`);
  }
  exitOnProblems(problems);
}

if (import.meta.main) {
  if (process.argv.includes("--runtime-entry")) {
    const runtime = measureRuntimeEntry(repoRoot());
    console.log(formatEntry(runtime));
  } else {
    await reportSize();
  }
}
