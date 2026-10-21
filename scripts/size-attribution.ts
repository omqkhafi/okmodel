/**
 * Attributes each gated graph from `scripts/size.ts` to source modules.
 *
 * The builds match that script: the runtime entry is `bun build --minify`
 * with no plugin, the app and each connect entry are `Bun.build` with the
 * same dynamic-import stub, and each adapter incremental is the minified
 * inputs that are not already in the runtime entry. A total that differs
 * from `size.ts` by more than a few bytes is a failure. The delta against
 * `tests/fixtures/size-attribution.json` is a report and does not fail.
 *
 * Runtime and startup modules are sourcemap ranges on that gated output.
 * `bytesInOutput` overshoots a single file (shared bytes are counted in
 * each input), so it is not a partition of the file `size.ts` measures.
 * The sourcemap build adds a debug id; the script strips that comment and
 * refuses to continue when the JavaScript still differs. Adapter
 * incremental bytes stay on `bytesInOutput`, because that sum is the gate.
 *
 *   bun ./scripts/size-attribution.ts
 *   bun ./scripts/size-attribution.ts --update
 *
 * On a pull request the inform job appends the delta to the job summary.
 * That job is not a required check.
 */

import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";
import { posixRelative } from "./posix.js";
import {
  ADAPTER_ENTRIES,
  APP_ENTRY,
  CONNECT_ENTRIES,
  RUNTIME_ENTRY,
  bundleInputBytes,
  incrementalMinBytes,
  measureEntry,
  measureStubbedStartup,
  startupChunkNames,
} from "./size.js";

/** How many modules the text report prints, largest first. */
export const TOP_MODULES = 25;

/**
 * Largest gap still treated as the same total as `scripts/size.ts`.
 *
 * Module bytes plus the unattributed remainder are exact. This slack is only
 * for the comparison with that script's own build.
 */
export const TOTAL_TOLERANCE = 8;

/** Committed per-module baseline. */
export const ATTRIBUTION_BASELINE = "tests/fixtures/size-attribution.json";

/** Bytes the sourcemap does not assign to a source file. */
export const UNATTRIBUTED = "(unattributed)";

const LAZY_STUB = "lazy-stub";

/**
 * Content-hash chunk names, same pattern as `scripts/size.ts`.
 *
 * Gzip of a startup graph replaces the hash with zeros of the same length
 * before compressing, so a lazy chunk whose only change is its id does not
 * move the number.
 */
const CHUNK_FILE = /^(.+)-([a-z0-9]{8})\.js$/;

/** One gated graph. */
export type GraphSpec = {
  /** Stable id in the baseline and the report. */
  readonly id: string;
  /** Which `size.ts` measurement this graph repeats. */
  readonly kind: "runtime" | "startup" | "incremental";
  /** Source entry, relative to the repository root. */
  readonly entry: string;
  /** Built entry filename. */
  readonly file: string;
  /** Packages left outside the bundle. */
  readonly external: readonly string[];
  /** Runtime entry subtracted from an incremental adapter graph. */
  readonly runtimeEntry: string;
};

/** Minified bytes of one source module and its share of the graph gzip. */
export type ModuleBytes = {
  /** Forward-slash path relative to the repository root, or `(unattributed)`. */
  readonly path: string;
  /** Minified bytes in the gated output. */
  readonly minBytes: number;
  /**
   * Share of the graph gzip, allocated by minified bytes.
   *
   * The shares of one graph sum to the graph gzip. It is an estimate: gzip
   * of the whole graph is smaller than gzip of each module alone.
   */
  readonly gzipBytes: number;
};

/** One gated graph after attribution. */
export type GraphAttribution = {
  /** {@link GraphSpec.id}. */
  readonly id: string;
  /** {@link GraphSpec.entry}. */
  readonly entry: string;
  /** {@link GraphSpec.kind}. */
  readonly kind: GraphSpec["kind"];
  /** Minified bytes of the gated output. */
  readonly minBytes: number;
  /** Gzip of that output, level 9, chunk ids normalised for a startup graph. */
  readonly gzipBytes: number;
  /** Minified bytes `scripts/size.ts` reports for the same graph. */
  readonly oracleMinBytes: number;
  /**
   * Gzip `scripts/size.ts` reports, or null for an adapter incremental.
   *
   * The incremental gate is minified bytes only.
   */
  readonly oracleGzipBytes: number | null;
  /** Modules sorted by path. Includes `(unattributed)` when the remainder is non-zero. */
  readonly modules: readonly ModuleBytes[];
};

/** Committed baseline. Graphs stay in {@link repoGraphSpecs} order. */
export type AttributionBaseline = {
  readonly graphs: readonly {
    readonly id: string;
    readonly entry: string;
    readonly kind: GraphSpec["kind"];
    readonly minBytes: number;
    readonly gzipBytes: number;
    readonly modules: readonly ModuleBytes[];
  }[];
};

/** One module whose bytes differ from the baseline. */
export type ModuleDelta = {
  readonly graph: string;
  readonly path: string;
  /** Null when the module is new. */
  readonly beforeMin: number | null;
  /** Null when the module was removed. */
  readonly afterMin: number | null;
  readonly beforeGzip: number | null;
  readonly afterGzip: number | null;
};

/**
 * Gated graphs, in report order.
 *
 * Runtime entry, featureless app startup, each connect entry's stubbed
 * startup, and each adapter incremental. Reported-only graphs (the Postgres
 * barrel, archivable, relations, the full app) are not included.
 *
 * @returns The specs `scripts/size.ts` gates
 */
export function repoGraphSpecs(): readonly GraphSpec[] {
  const specs: GraphSpec[] = [
    {
      id: "runtime",
      kind: "runtime",
      entry: RUNTIME_ENTRY,
      file: "runtime.js",
      external: [],
      runtimeEntry: RUNTIME_ENTRY,
    },
    {
      id: "app",
      kind: "startup",
      entry: APP_ENTRY,
      file: "app-startup.js",
      external: ["postgres"],
      runtimeEntry: RUNTIME_ENTRY,
    },
  ];
  for (const entry of CONNECT_ENTRIES) {
    specs.push({
      id: `connect:${entry.entry}`,
      kind: "startup",
      entry: entry.entry,
      file: entry.file,
      external: entry.external,
      runtimeEntry: RUNTIME_ENTRY,
    });
  }
  for (const entry of ADAPTER_ENTRIES) {
    const stem = basename(entry.entry, ".ts");
    specs.push({
      id: `adapter:${entry.entry}`,
      kind: "incremental",
      entry: entry.entry,
      file: `${stem}.js`,
      external: entry.external,
      runtimeEntry: RUNTIME_ENTRY,
    });
  }
  return specs;
}

/**
 * Problems when a graph total is not the `size.ts` total.
 *
 * Module bytes must sum to the graph. The oracle comparison allows
 * {@link TOTAL_TOLERANCE}. An incremental graph has no gzip oracle.
 *
 * @param graph - One attributed graph
 * @returns Problem lines. Empty when the totals agree
 */
export function totalProblems(graph: GraphAttribution): readonly string[] {
  const problems: string[] = [];
  const summed = graph.modules.reduce((sum, mod) => sum + mod.minBytes, 0);
  if (summed !== graph.minBytes) {
    problems.push(
      `size-attribution: ${graph.id} modules sum to ${String(summed)} minified bytes, graph is ${String(graph.minBytes)}`,
    );
  }
  const gzipSum = graph.modules.reduce((sum, mod) => sum + mod.gzipBytes, 0);
  if (gzipSum !== graph.gzipBytes) {
    problems.push(
      `size-attribution: ${graph.id} gzip shares sum to ${String(gzipSum)}, graph gzip is ${String(graph.gzipBytes)}`,
    );
  }
  const minGap = Math.abs(graph.minBytes - graph.oracleMinBytes);
  if (minGap > TOTAL_TOLERANCE) {
    problems.push(
      `size-attribution: ${graph.id} min ${String(graph.minBytes)} differs from size.ts ${String(graph.oracleMinBytes)} by ${String(minGap)}`,
    );
  }
  if (graph.oracleGzipBytes !== null) {
    const gzipGap = Math.abs(graph.gzipBytes - graph.oracleGzipBytes);
    if (gzipGap > TOTAL_TOLERANCE) {
      problems.push(
        `size-attribution: ${graph.id} gzip ${String(graph.gzipBytes)} differs from size.ts ${String(graph.oracleGzipBytes)} by ${String(gzipGap)}`,
      );
    }
  }
  return problems;
}

/**
 * Attributes every gated graph.
 *
 * @param root - Repository root
 * @returns Graphs in {@link repoGraphSpecs} order
 */
export async function attributeRepo(root: string): Promise<readonly GraphAttribution[]> {
  const graphs: GraphAttribution[] = [];
  for (const spec of repoGraphSpecs()) {
    graphs.push(await attributeGraph(root, spec));
  }
  return graphs;
}

/**
 * Attributes one graph.
 *
 * @param root - Repository root
 * @param spec - Which build to repeat
 * @returns Per-module bytes
 */
export async function attributeGraph(root: string, spec: GraphSpec): Promise<GraphAttribution> {
  if (spec.kind === "runtime") return attributeRuntime(root, spec);
  if (spec.kind === "startup") return attributeStartup(root, spec);
  return attributeIncremental(root, spec);
}

/**
 * Modules whose minified or gzip bytes differ, including additions and removals.
 *
 * A matching module is omitted. Order is the largest absolute minified change
 * first, then graph id, then path.
 *
 * @param current - Graphs just measured
 * @param baseline - Committed baseline
 * @returns The changed modules
 */
export function attributionDelta(
  current: readonly GraphAttribution[],
  baseline: AttributionBaseline,
): readonly ModuleDelta[] {
  const deltas: ModuleDelta[] = [];
  const baseById = new Map(baseline.graphs.map((graph) => [graph.id, graph]));
  const seen = new Set<string>();
  for (const graph of current) {
    seen.add(graph.id);
    const before = new Map((baseById.get(graph.id)?.modules ?? []).map((mod) => [mod.path, mod]));
    const after = new Set<string>();
    for (const mod of graph.modules) {
      after.add(mod.path);
      const previous = before.get(mod.path);
      if (previous === undefined) {
        deltas.push({
          graph: graph.id,
          path: mod.path,
          beforeMin: null,
          afterMin: mod.minBytes,
          beforeGzip: null,
          afterGzip: mod.gzipBytes,
        });
        continue;
      }
      if (previous.minBytes !== mod.minBytes || previous.gzipBytes !== mod.gzipBytes) {
        deltas.push({
          graph: graph.id,
          path: mod.path,
          beforeMin: previous.minBytes,
          afterMin: mod.minBytes,
          beforeGzip: previous.gzipBytes,
          afterGzip: mod.gzipBytes,
        });
      }
    }
    for (const [path, previous] of before) {
      if (after.has(path)) continue;
      deltas.push({
        graph: graph.id,
        path,
        beforeMin: previous.minBytes,
        afterMin: null,
        beforeGzip: previous.gzipBytes,
        afterGzip: null,
      });
    }
  }
  for (const graph of baseline.graphs) {
    if (seen.has(graph.id)) continue;
    for (const mod of graph.modules) {
      deltas.push({
        graph: graph.id,
        path: mod.path,
        beforeMin: mod.minBytes,
        afterMin: null,
        beforeGzip: mod.gzipBytes,
        afterGzip: null,
      });
    }
  }
  deltas.sort((left, right) => {
    const gap = Math.abs(change(right)) - Math.abs(change(left));
    if (gap !== 0) return gap;
    if (left.graph < right.graph) return -1;
    if (left.graph > right.graph) return 1;
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  });
  return deltas;
}

/**
 * Text report: top modules, then the total, then the delta.
 *
 * @param graphs - Attributed graphs
 * @param deltas - Modules that differ from the baseline. Empty when there is no baseline yet
 * @param baselineNote - Printed when the baseline file is missing
 * @returns The report, ending in a newline
 */
export function formatReport(
  graphs: readonly GraphAttribution[],
  deltas: readonly ModuleDelta[],
  baselineNote?: string,
): string {
  const lines: string[] = [];
  for (const graph of graphs) {
    lines.push(`size-attribution: ${graph.id} ${graph.entry} (${graph.kind})`);
    const ranked = [...graph.modules].sort(bySize);
    for (const mod of ranked.slice(0, TOP_MODULES)) {
      lines.push(`  ${mod.path}  min ${String(mod.minBytes)}  gzip ${String(mod.gzipBytes)}`);
    }
    if (ranked.length > TOP_MODULES) {
      lines.push(`  … ${String(ranked.length - TOP_MODULES)} more`);
    }
    const oracleGzip =
      graph.oracleGzipBytes === null ? "" : ` gzip ${String(graph.oracleGzipBytes)}`;
    lines.push(
      `  total  min ${String(graph.minBytes)}  gzip ${String(graph.gzipBytes)}  (size.ts min ${String(graph.oracleMinBytes)}${oracleGzip})`,
    );
  }
  if (baselineNote !== undefined) lines.push(baselineNote);
  lines.push(...formatDeltaLines(deltas));
  return `${lines.join("\n")}\n`;
}

/**
 * Markdown for the GitHub job summary.
 *
 * @param graphs - Attributed graphs
 * @param deltas - Modules that differ from the baseline
 * @returns Markdown ending in a newline
 */
export function summaryMarkdown(
  graphs: readonly GraphAttribution[],
  deltas: readonly ModuleDelta[],
): string {
  const lines = ["### Size attribution", "", "| Graph | Min | Gzip |", "| --- | ---: | ---: |"];
  for (const graph of graphs) {
    lines.push(`| \`${graph.id}\` | ${String(graph.minBytes)} | ${String(graph.gzipBytes)} |`);
  }
  lines.push("");
  if (deltas.length === 0) {
    lines.push("No module changed against `tests/fixtures/size-attribution.json`.");
  } else {
    lines.push("| Graph | Module | Δ min | Δ gzip |");
    lines.push("| --- | --- | ---: | ---: |");
    for (const delta of deltas) {
      lines.push(
        `| \`${delta.graph}\` | \`${delta.path}\` | ${signed(delta.beforeMin, delta.afterMin)} | ${signed(delta.beforeGzip, delta.afterGzip)} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Reads the baseline. Returns undefined when the file is missing.
 *
 * @param root - Repository root
 * @returns The baseline, or undefined when it has not been written
 */
export function readAttributionBaseline(root: string): AttributionBaseline | undefined {
  const path = join(root, ATTRIBUTION_BASELINE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  return parseBaseline(text);
}

/**
 * Writes the baseline. Modules stay sorted by path.
 *
 * @param root - Repository root
 * @param graphs - Graphs to store
 */
export function writeAttributionBaseline(root: string, graphs: readonly GraphAttribution[]): void {
  const body: AttributionBaseline = {
    graphs: graphs.map((graph) => ({
      id: graph.id,
      entry: graph.entry,
      kind: graph.kind,
      minBytes: graph.minBytes,
      gzipBytes: graph.gzipBytes,
      modules: [...graph.modules].sort(byPath),
    })),
  };
  writeFileSync(join(root, ATTRIBUTION_BASELINE), `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * Empties every relative dynamic `import()` during a build.
 *
 * Same plugin as `scripts/size.ts`. The stub key is the importer plus the
 * specifier, because `build.resolve` is not implemented and the specifier
 * alone would merge `./batch.js` from two directories. An `onResolve` hook
 * changes mangling even when it stubs nothing, so the runtime entry does
 * not use this plugin.
 *
 * @returns The plugin passed to `Bun.build`
 */
function stubDynamicPlugin(): Bun.BunPlugin {
  return {
    name: "stub-dynamic-imports",
    setup(build) {
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (args.kind !== "dynamic-import" || args.namespace === LAZY_STUB) return;
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
 * Replaces content-hash chunk ids with a fixed id of the same length.
 *
 * Copied from `scripts/size.ts`. Gzip of a startup graph uses this copy.
 *
 * @param dir - Build output that holds the chunk files
 * @param bytes - Startup graph, concatenated in walk order
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

function attributeRuntime(root: string, spec: GraphSpec): GraphAttribution {
  const built = buildSingle(root, spec.entry, spec.external, false, true);
  try {
    const oracle = measureEntry(root, spec.entry, spec.external);
    return finish(
      spec,
      built.modules,
      built.minBytes,
      built.gzipBytes,
      oracle.minBytes,
      oracle.gzipBytes,
    );
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
}

async function attributeStartup(root: string, spec: GraphSpec): Promise<GraphAttribution> {
  const built = await buildStubbed(root, spec);
  try {
    const oracle = await measureStubbedStartup(root, spec.entry, spec.file, spec.external);
    return finish(
      spec,
      built.modules,
      built.minBytes,
      built.gzipBytes,
      oracle.minBytes,
      oracle.gzipBytes,
    );
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
}

function attributeIncremental(root: string, spec: GraphSpec): GraphAttribution {
  const runtime = bundleInputBytes(root, spec.runtimeEntry);
  const adapter = bundleInputBytes(root, spec.entry, spec.external);
  const oracle = incrementalMinBytes(adapter, runtime);
  const built = buildSingle(root, spec.entry, spec.external, true, false);
  try {
    const rows = new Map<string, { minBytes: number; unique: boolean }>();
    for (const [file, bytes] of adapter.files) {
      if (bytes === 0) continue;
      const path = modulePath(file, root);
      const unique = !runtime.files.has(file);
      const previous = rows.get(path);
      if (previous === undefined) {
        rows.set(path, { minBytes: bytes, unique });
      } else {
        rows.set(path, { minBytes: previous.minBytes + bytes, unique: previous.unique && unique });
      }
    }
    const all = [...rows.entries()]
      .map(([path, row]) => ({ path, minBytes: row.minBytes, unique: row.unique }))
      .sort(byPath);
    const shares = allocateShares(
      built.gzipBytes,
      all.map((row) => row.minBytes),
    );
    const modules: ModuleBytes[] = [];
    for (const [index, row] of all.entries()) {
      if (!row.unique) continue;
      modules.push({ path: row.path, minBytes: row.minBytes, gzipBytes: shares[index] ?? 0 });
    }
    const minBytes = modules.reduce((sum, mod) => sum + mod.minBytes, 0);
    const gzipBytes = modules.reduce((sum, mod) => sum + mod.gzipBytes, 0);
    return {
      id: spec.id,
      entry: spec.entry,
      kind: spec.kind,
      minBytes,
      gzipBytes,
      oracleMinBytes: oracle,
      oracleGzipBytes: null,
      modules,
    };
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
}

function finish(
  spec: GraphSpec,
  weights: readonly { path: string; minBytes: number }[],
  minBytes: number,
  gzipBytes: number,
  oracleMinBytes: number,
  oracleGzipBytes: number | null,
): GraphAttribution {
  const rows = [...weights];
  const attributed = rows.reduce((sum, row) => sum + row.minBytes, 0);
  const glue = minBytes - attributed;
  if (glue < 0) {
    throw new Error(
      `size-attribution: ${spec.id} attributes ${String(attributed)} bytes but the output is ${String(minBytes)}`,
    );
  }
  if (glue > 0) rows.push({ path: UNATTRIBUTED, minBytes: glue });
  rows.sort(byPath);
  const shares = allocateShares(
    gzipBytes,
    rows.map((row) => row.minBytes),
  );
  return {
    id: spec.id,
    entry: spec.entry,
    kind: spec.kind,
    minBytes,
    gzipBytes,
    oracleMinBytes,
    oracleGzipBytes,
    modules: rows.map((row, index) => ({
      path: row.path,
      minBytes: row.minBytes,
      gzipBytes: shares[index] ?? 0,
    })),
  };
}

type BuiltGraph = {
  readonly dir: string;
  readonly minBytes: number;
  readonly gzipBytes: number;
  readonly modules: { path: string; minBytes: number }[];
};

/**
 * One minified file, matching `measureEntry` or `bundleInputBytes`.
 *
 * `split` is false for the runtime entry (`--outfile`, no metafile effect on
 * the bytes). The adapter build uses `--outdir` like `bundleInputBytes`.
 * Gzip is the raw file. Chunk ids are not rewritten: this build does not split.
 *
 * @param root - Repository root
 * @param entry - Source entry, relative to `root`
 * @param external - Packages left outside the bundle
 * @param outdir - True for the adapter build (`--outdir`), false for `--outfile`
 * @returns Bytes and a directory the caller deletes
 */
function buildSingle(
  root: string,
  entry: string,
  external: readonly string[],
  outdir: boolean,
  attribute: boolean,
): BuiltGraph {
  const dir = makeBuildDir(root, external);
  const mappedDir = attribute ? makeBuildDir(root, external) : undefined;
  try {
    compileSingle(root, entry, external, dir, outdir, false);
    const names = listOutputs(dir);
    let modules: { path: string; minBytes: number }[] = [];
    if (mappedDir !== undefined) {
      compileSingle(root, entry, external, mappedDir, outdir, true);
      modules = attributeOutputs(root, entry, dir, mappedDir, names);
    }
    const parts = listOutputs(dir).map((name) => readFileSync(join(dir, name)));
    const bytes = Buffer.concat(parts);
    return {
      dir,
      minBytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
      modules,
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    if (mappedDir !== undefined) rmSync(mappedDir, { recursive: true, force: true });
  }
}

/**
 * One `bun build`, matching `measureEntry` or `bundleInputBytes`.
 *
 * @param root - Repository root
 * @param entry - Source entry, relative to `root`
 * @param external - Packages left outside the bundle
 * @param dir - Output directory
 * @param outdir - True for `--outdir`, false for `--outfile`
 * @param sourcemap - True to write an external sourcemap beside the JavaScript
 */
function compileSingle(
  root: string,
  entry: string,
  external: readonly string[],
  dir: string,
  outdir: boolean,
  sourcemap: boolean,
): void {
  const outfile = join(dir, "runtime.js");
  const mapToDir = sourcemap || outdir;
  const args = [
    "bun",
    "build",
    join(root, entry),
    "--target",
    "node",
    "--minify",
    mapToDir ? "--outdir" : "--outfile",
    mapToDir ? dir : outfile,
    ...external.flatMap((name) => ["--external", name]),
  ];
  if (sourcemap) args.push("--sourcemap=external");
  const proc = Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(
      `size-attribution: bun build ${entry} exited ${String(proc.exitCode)}\n${proc.stderr.toString()}`,
    );
  }
}

/**
 * Stubbed startup graph, matching `measureStubbedStartup`.
 *
 * @param root - Repository root
 * @param spec - Startup spec. `file` is the built entry name
 * @returns Bytes and a directory the caller deletes
 */
async function buildStubbed(root: string, spec: GraphSpec): Promise<BuiltGraph> {
  const dir = makeBuildDir(root, spec.external);
  const mappedDir = makeBuildDir(root, spec.external);
  try {
    await compileStubbed(root, spec, dir, false);
    await compileStubbed(root, spec, mappedDir, true);
    const startup = startupChunkNames(dir, spec.file);
    const parts: Buffer[] = [];
    let minBytes = 0;
    for (const name of startup) {
      const plain = readFileSync(join(dir, name));
      minBytes += plain.byteLength;
      parts.push(plain);
    }
    const gzipBytes = gzipSync(normaliseChunkIds(dir, Buffer.concat(parts)), {
      level: 9,
    }).byteLength;
    return {
      dir,
      minBytes,
      gzipBytes,
      modules: attributeOutputs(root, spec.id, dir, mappedDir, startup),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(mappedDir, { recursive: true, force: true });
  }
}

/**
 * Stubbed `Bun.build`, with or without an external sourcemap.
 *
 * The plain build passes `metafile: true` because {@link measureStubbedStartup}
 * does. The flag does not change the JavaScript; keeping it makes this the
 * same call.
 *
 * @param root - Repository root
 * @param spec - Startup spec
 * @param dir - Output directory
 * @param sourcemap - True to write an external sourcemap
 */
async function compileStubbed(
  root: string,
  spec: GraphSpec,
  dir: string,
  sourcemap: boolean,
): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(root, spec.entry)],
    target: "node",
    minify: true,
    splitting: true,
    outdir: dir,
    external: [...spec.external],
    metafile: true,
    ...(sourcemap ? { sourcemap: "external" as const } : {}),
    plugins: [stubDynamicPlugin()],
  });
  if (!result.success) {
    const message = result.logs.map((log) => log.message).join("\n");
    throw new Error(`size-attribution: bun build ${spec.entry} exited\n${message}`);
  }
}

/**
 * Sourcemap ranges for each gated file.
 *
 * The mapped build must be the gated JavaScript plus Bun's debug-id comment.
 * Any other difference is a failure: the ranges would describe a different file.
 *
 * @param root - Repository root
 * @param label - Graph id, used in errors
 * @param dir - Gated build output
 * @param mappedDir - Sourcemap build output
 * @param names - Gated filenames, in startup order
 * @returns Minified bytes per source module
 */
function attributeOutputs(
  root: string,
  label: string,
  dir: string,
  mappedDir: string,
  names: readonly string[],
): { path: string; minBytes: number }[] {
  const totals = new Map<string, number>();
  for (const name of names) {
    const plain = readFileSync(join(dir, name));
    const mappedName = sourcemapOutput(mappedDir, name);
    const mapped = readFileSync(join(mappedDir, mappedName), "utf8");
    const code = gatedText(plain.toString("utf8"), mapped, `${label} ${name}`);
    if (Buffer.byteLength(code, "utf8") !== plain.byteLength) {
      throw new Error(`size-attribution: ${label} ${name} is not utf8`);
    }
    const mapText = readFileSync(join(mappedDir, `${mappedName}.map`), "utf8");
    for (const row of modulesFromSourcemap(code, mapText, mappedDir, root)) {
      totals.set(row.path, (totals.get(row.path) ?? 0) + row.minBytes);
    }
  }
  return [...totals.entries()].map(([path, minBytes]) => ({ path, minBytes }));
}

/**
 * Sourcemap build's JavaScript for a gated filename.
 *
 * `bun build --sourcemap=external` requires `--outdir`, which names the file
 * after the entry. The gated runtime build uses `--outfile runtime.js`.
 * A one-file graph pairs those two names. A split graph uses the same name.
 *
 * @param mappedDir - Sourcemap build output
 * @param name - Gated filename
 * @returns Filename inside `mappedDir`
 */
function sourcemapOutput(mappedDir: string, name: string): string {
  if (existsSync(join(mappedDir, name))) return name;
  const outputs = listOutputs(mappedDir);
  const only = outputs.length === 1 ? outputs[0] : undefined;
  if (only !== undefined) return only;
  throw new Error(`size-attribution: sourcemap build has no ${name}`);
}

const SOURCEMAP_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Gated JavaScript, confirmed against the sourcemap build.
 *
 * Bun appends `//# debugId=` and sometimes a sourceMappingURL. After those
 * comments are removed, the mapped file may still carry one extra trailing
 * newline. Any earlier difference fails the build.
 *
 * @param plain - Gated file, as text
 * @param mapped - Sourcemap build of the same file
 * @param label - Graph and filename, for the error
 * @returns `plain` when the mapped build describes it
 */
function gatedText(plain: string, mapped: string, label: string): string {
  let stripped = mapped
    .replaceAll(/\n?\/\/# debugId=[0-9A-Fa-f]+/g, "")
    .replaceAll(/\n?\/\/# sourceMappingURL=\S+/g, "");
  if (stripped.endsWith("\n") && stripped.slice(0, -1) === plain) stripped = plain;
  if (stripped === plain) return plain;
  const length = Math.min(plain.length, stripped.length);
  let index = 0;
  while (index < length && plain[index] === stripped[index]) index += 1;
  throw new Error(
    `size-attribution: ${label} sourcemap build differs from the gated build at ${String(index)}`,
  );
}

type ParsedMap = {
  readonly sources: readonly string[];
  readonly mappings: string;
  readonly sourceRoot?: string;
};

function readSourceMap(text: string): ParsedMap {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("size-attribution: sourcemap is not an object");
  }
  const record = parsed as {
    readonly sources?: unknown;
    readonly mappings?: unknown;
    readonly sourceRoot?: unknown;
  };
  if (!Array.isArray(record.sources) || typeof record.mappings !== "string") {
    throw new Error("size-attribution: sourcemap is missing sources or mappings");
  }
  const sources: string[] = [];
  for (const source of record.sources) {
    if (typeof source !== "string")
      throw new Error("size-attribution: sourcemap source is not a string");
    sources.push(source);
  }
  if (typeof record.sourceRoot === "string") {
    return { sources, mappings: record.mappings, sourceRoot: record.sourceRoot };
  }
  return { sources, mappings: record.mappings };
}

type MapSegment = {
  readonly column: number;
  readonly source: number | null;
};

function decodeMappings(mappings: string): MapSegment[][] {
  let sourceIndex = 0;
  return mappings.split(";").map((line) => {
    const segments: MapSegment[] = [];
    let column = 0;
    if (line.length === 0) return segments;
    for (const part of line.split(",")) {
      const fields = decodeVlq(part);
      const generated = fields[0];
      if (generated === undefined) continue;
      column += generated;
      if (column < 0) throw new Error("size-attribution: sourcemap column went negative");
      if (fields.length === 1) {
        segments.push({ column, source: null });
        continue;
      }
      const sourceDelta = fields[1];
      if (sourceDelta === undefined || fields.length < 4) {
        throw new Error("size-attribution: sourcemap segment is incomplete");
      }
      sourceIndex += sourceDelta;
      segments.push({ column, source: sourceIndex });
    }
    return segments;
  });
}

function decodeVlq(part: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (let index = 0; index < part.length; index += 1) {
    const char = part[index];
    if (char === undefined) continue;
    const integer = SOURCEMAP_B64.indexOf(char);
    if (integer < 0) throw new Error(`size-attribution: bad sourcemap character ${char}`);
    value += (integer & 31) << shift;
    if ((integer & 32) !== 0) {
      shift += 5;
      continue;
    }
    const negative = (value & 1) === 1;
    const magnitude = value >>> 1;
    values.push(negative ? -magnitude : magnitude);
    value = 0;
    shift = 0;
  }
  if (shift !== 0) throw new Error("size-attribution: truncated sourcemap segment");
  return values;
}

/**
 * Minified bytes per source file, from generated-column ranges.
 *
 * A range with no source, or a stub module (`\0` in the path), is left out.
 * {@link finish} records that gap as `(unattributed)`. The walk covers every
 * byte of `code`; a short walk is a decoder bug. Bun sometimes emits a
 * generated column a few bytes before the previous one. Segments are sorted
 * and each byte keeps the mapping with the greatest column at or before it.
 *
 * @param code - Gated JavaScript
 * @param mapText - Sourcemap JSON
 * @param mapDir - Directory the sourcemap was written to
 * @param root - Graph root. Sources are made relative to it
 * @returns One row per source that contributed bytes
 */
function modulesFromSourcemap(
  code: string,
  mapText: string,
  mapDir: string,
  root: string,
): { path: string; minBytes: number }[] {
  const map = readSourceMap(mapText);
  const lines = decodeMappings(map.mappings);
  const parts = code.split("\n");
  const totals = new Map<string, number>();
  let covered = 0;
  const add = (source: number | null, text: string): void => {
    if (text.length === 0) return;
    const bytes = Buffer.byteLength(text, "utf8");
    covered += bytes;
    if (source === null) return;
    const sourceName = map.sources[source];
    if (sourceName === undefined) {
      throw new Error(`size-attribution: sourcemap source ${String(source)} is missing`);
    }
    const path = resolveMappedSource(sourceName, map.sourceRoot, mapDir, root);
    if (path === null) return;
    totals.set(path, (totals.get(path) ?? 0) + bytes);
  };
  for (let index = 0; index < parts.length; index += 1) {
    const line = parts[index] ?? "";
    const newline = index < parts.length - 1 ? "\n" : "";
    const segments = lines[index] ?? [];
    const ordered = segments
      .map((segment, order) => ({ column: segment.column, source: segment.source, order }))
      .sort((left, right) => left.column - right.column || left.order - right.order);
    const pieces: { column: number; source: number | null }[] = [];
    for (const segment of ordered) {
      if (segment.column > line.length) {
        throw new Error(
          `size-attribution: sourcemap column ${String(segment.column)} is outside line ${String(index)} (${String(line.length)})`,
        );
      }
      const previous = pieces.at(-1);
      if (previous !== undefined && previous.column === segment.column) {
        pieces[pieces.length - 1] = { column: segment.column, source: segment.source };
        continue;
      }
      pieces.push({ column: segment.column, source: segment.source });
    }
    if (pieces[0]?.column !== 0) pieces.unshift({ column: 0, source: null });
    for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
      const piece = pieces[pieceIndex];
      if (piece === undefined) continue;
      const next = pieces[pieceIndex + 1]?.column ?? line.length;
      const text =
        pieceIndex === pieces.length - 1
          ? `${line.slice(piece.column, next)}${newline}`
          : line.slice(piece.column, next);
      add(piece.source, text);
    }
  }
  const expected = Buffer.byteLength(code, "utf8");
  if (covered !== expected) {
    throw new Error(
      `size-attribution: sourcemap covered ${String(covered)} bytes of ${String(expected)}`,
    );
  }
  return [...totals.entries()].map(([path, minBytes]) => ({ path, minBytes }));
}

/**
 * A sourcemap source as a forward-slash path relative to `root`.
 *
 * Stub modules created by the dynamic-import plugin are not files. They
 * return null so their bytes stay unattributed.
 *
 * @param source - `sources` entry
 * @param sourceRoot - Optional prefix from the sourcemap
 * @param mapDir - Directory the sourcemap was written to
 * @param root - Graph root
 * @returns The relative path, or null for a stub
 */
function resolveMappedSource(
  source: string,
  sourceRoot: string | undefined,
  mapDir: string,
  root: string,
): string | null {
  if (source.includes("\0")) return null;
  const prefixed =
    sourceRoot !== undefined &&
    sourceRoot !== "" &&
    !sourceRoot.includes("://") &&
    !isAbsolute(source)
      ? `${sourceRoot.replace(/\/$/u, "")}/${source}`
      : source;
  const absolute = isAbsolute(prefixed) ? prefixed : resolve(mapDir, prefixed);
  let target: string;
  try {
    target = realpathSync(absolute);
  } catch {
    throw new Error(`size-attribution: sourcemap source ${source} is not a file`);
  }
  const rel = relative(realpathSync(root), target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`size-attribution: sourcemap source ${source} is outside ${root}`);
  }
  return rel.split(sep).join("/");
}

/**
 * A metafile input as a forward-slash path relative to `root`.
 *
 * `bun build` paths are relative to the repository. `Bun.build` paths follow
 * the process cwd. A fixture outside the root stays a relative path from it.
 *
 * @param input - Metafile input path
 * @param root - Directory the entry was built from
 * @returns A forward-slash path
 */
function modulePath(input: string, root: string): string {
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
    if (!rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
  }
  const fallback = isAbsolute(input) ? input : resolve(base, input);
  return posixRelative(base, fallback);
}

function listOutputs(dir: string): readonly string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .sort();
}

function makeBuildDir(root: string, external: readonly string[]): string {
  const parent = external.length > 0 ? join(root, "node_modules") : tmpdir();
  return mkdtempSync(join(parent, external.length > 0 ? ".okm-size-" : "okm-size-"));
}

/**
 * Splits `total` across `weights` so the shares sum to `total`.
 *
 * The largest fractional part gets the next byte. A tie goes to the earlier
 * index, and callers sort by path first so the split does not depend on
 * insertion order.
 *
 * @param total - Bytes to distribute
 * @param weights - Non-negative weights
 * @returns One share per weight
 */
export function allocateShares(total: number, weights: readonly number[]): readonly number[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (sum === 0 || weights.length === 0) return weights.map(() => 0);
  const shares = weights.map((weight) => Math.floor((total * weight) / sum));
  let left = total - shares.reduce((acc, share) => acc + share, 0);
  const order = weights
    .map((weight, index) => ({ index, remainder: (total * weight) % sum }))
    .sort(
      (leftSide, rightSide) =>
        rightSide.remainder - leftSide.remainder || leftSide.index - rightSide.index,
    );
  for (const item of order) {
    if (left === 0) break;
    const share = shares[item.index];
    if (share === undefined) continue;
    shares[item.index] = share + 1;
    left -= 1;
  }
  return shares;
}

function bySize(left: ModuleBytes, right: ModuleBytes): number {
  if (right.minBytes !== left.minBytes) return right.minBytes - left.minBytes;
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function byPath(left: { path: string }, right: { path: string }): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function change(delta: ModuleDelta): number {
  if (delta.beforeMin === null) return delta.afterMin ?? 0;
  if (delta.afterMin === null) return -delta.beforeMin;
  return delta.afterMin - delta.beforeMin;
}

function signed(before: number | null, after: number | null): string {
  if (before === null) return `+${String(after ?? 0)}`;
  if (after === null) return `-${String(before)}`;
  const gap = after - before;
  return gap > 0 ? `+${String(gap)}` : String(gap);
}

function formatDeltaLines(deltas: readonly ModuleDelta[]): readonly string[] {
  if (deltas.length === 0) return ["size-attribution: no module changed"];
  const lines = [
    `size-attribution: ${String(deltas.length)} module${deltas.length === 1 ? "" : "s"} changed`,
  ];
  for (const delta of deltas) {
    lines.push(
      `  ${delta.graph}  ${delta.path}  min ${signed(delta.beforeMin, delta.afterMin)}  gzip ${signed(delta.beforeGzip, delta.afterGzip)}`,
    );
  }
  return lines;
}

function parseBaseline(text: string): AttributionBaseline {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !Array.isArray(parsed.graphs)) {
    throw new Error(`size-attribution: ${ATTRIBUTION_BASELINE} has no graphs`);
  }
  const graphs: AttributionBaseline["graphs"][number][] = [];
  for (const graph of parsed.graphs) {
    if (!isRecord(graph)) {
      throw new Error(`size-attribution: ${ATTRIBUTION_BASELINE} has a graph without an id`);
    }
    const id = graph.id;
    const kind = graph.kind;
    const modules = graph.modules;
    if (typeof id !== "string" || !Array.isArray(modules)) {
      throw new Error(`size-attribution: ${ATTRIBUTION_BASELINE} has a graph without an id`);
    }
    if (kind !== "runtime" && kind !== "startup" && kind !== "incremental") {
      throw new Error(`size-attribution: ${id} has an unknown kind`);
    }
    graphs.push({
      id,
      entry: typeof graph.entry === "string" ? graph.entry : "",
      kind,
      minBytes: numberField(graph.minBytes, id),
      gzipBytes: numberField(graph.gzipBytes, id),
      modules: modules.map((mod) => {
        if (!isRecord(mod) || typeof mod.path !== "string") {
          throw new Error(`size-attribution: ${id} has a module without a path`);
        }
        return {
          path: mod.path,
          minBytes: numberField(mod.minBytes, mod.path),
          gzipBytes: numberField(mod.gzipBytes, mod.path),
        };
      }),
    });
  }
  return { graphs };
}

function numberField(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `size-attribution: ${where} has a byte count that is not a non-negative integer`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { update: { type: "boolean" } },
    strict: true,
  });
  const root = repoRoot();
  const graphs = await attributeRepo(root);
  const problems = graphs.flatMap(totalProblems);
  const baseline = readAttributionBaseline(root);
  const deltas = baseline === undefined ? [] : attributionDelta(graphs, baseline);
  const note =
    baseline === undefined ? `size-attribution: no baseline at ${ATTRIBUTION_BASELINE}` : undefined;
  const report = formatReport(graphs, deltas, note);
  process.stdout.write(report);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary.length > 0) {
    const body = summaryMarkdown(graphs, deltas);
    const extra =
      problems.length === 0
        ? body
        : `${body}\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`;
    appendFileSync(summary, extra);
  }
  if (problems.length > 0) exitOnProblems(problems);
  if (values.update === true) {
    writeAttributionBaseline(root, graphs);
    console.log(`size-attribution: wrote ${ATTRIBUTION_BASELINE}`);
  }
}

if (import.meta.main) {
  await main();
}
