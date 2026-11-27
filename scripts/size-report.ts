/**
 * Pull-request size and type-cost summary.
 *
 * Startup, connect graphs, the runtime entry, adapters, the CLI chunk sum,
 * tarball size, the type-cost table, and a cold-import median of 10 are
 * printed and appended to `GITHUB_STEP_SUMMARY`. Deltas are against
 * `tests/fixtures/size-report.json`, which is updated by hand at release
 * prep. The script does not write that file and does not fail.
 *
 *   bun ./scripts/size-report.ts
 */

import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPacked } from "./pack-contract.js";
import { repoRoot } from "./root.js";
import {
  ADAPTER_ENTRIES,
  APP_ENTRY,
  CONNECT_ENTRIES,
  REPORT_COLD_IMPORT_SAMPLES,
  RUNTIME_ENTRY,
  bundleInputBytes,
  incrementalMinBytes,
  measureEntry,
  measureStubbedStartup,
} from "./size.js";
import { measureTypeBudgets, typeCostLines } from "./type-cost.js";

/** Baseline path, relative to the repository root. */
export const SIZE_REPORT_BASELINE = "tests/fixtures/size-report.json";

/** Minified and gzip bytes of one graph. */
export type BytePair = {
  readonly minBytes: number;
  readonly gzipBytes: number;
};

/** Numbers the summary compares to the hand-kept baseline. */
export type SizeReportNumbers = {
  readonly startup: BytePair;
  readonly runtimeEntry: BytePair & { readonly coldImportMs: number };
  readonly connect: Readonly<Record<string, BytePair>>;
  readonly adapters: Readonly<Record<string, BytePair & { readonly incrementalMinBytes: number }>>;
  readonly cliChunkBytes: number;
  readonly tarballBytes: number | undefined;
  readonly typeCost: Readonly<
    Record<string, { readonly instantiations: number; readonly types: number }>
  >;
  readonly notes: readonly string[];
};

/** Parsed baseline. Missing keys are omitted. */
export type SizeReportBaseline = {
  readonly startup?: BytePair;
  readonly runtimeEntry?: BytePair & { readonly coldImportMs?: number };
  readonly connect?: Readonly<Record<string, BytePair>>;
  readonly adapters?: Readonly<
    Record<string, BytePair & { readonly incrementalMinBytes?: number }>
  >;
  readonly cliChunkBytes?: number;
  readonly tarballBytes?: number;
  readonly typeCost?: Readonly<
    Record<string, { readonly instantiations?: number; readonly types?: number }>
  >;
};

const CLI_ENTRY = "src/tooling/cli.ts";
const CLI_EXTERNALS = [
  "postgres",
  "@electric-sql/pglite",
  "pg",
  "bun",
  "@neondatabase/serverless",
] as const;

/**
 * Signed difference, or `no baseline` when the baseline has no number.
 *
 * @param actual - Measured value
 * @param baseline - Hand-kept value, when present
 * @param digits - Fraction digits. Zero prints an integer
 * @returns The delta text
 */
export function signedDelta(actual: number, baseline: number | undefined, digits = 0): string {
  if (baseline === undefined || !Number.isFinite(baseline)) return "no baseline";
  const diff = actual - baseline;
  const body = digits === 0 ? String(Math.round(diff)) : diff.toFixed(digits);
  if (diff > 0) return `+${body}`;
  return body;
}

/**
 * Reads the hand-kept baseline.
 *
 * A missing or unreadable file is an empty baseline. The report still runs.
 *
 * @param root - Repository root
 * @returns The parsed object, or empty
 */
export function readSizeReportBaseline(root: string): SizeReportBaseline {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, SIZE_REPORT_BASELINE), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as SizeReportBaseline;
  } catch {
    return {};
  }
}

/**
 * Markdown for the job summary.
 *
 * @param measured - This run
 * @param baseline - Hand-kept numbers
 * @returns A section ending in a newline
 */
export function sizeReportMarkdown(
  measured: SizeReportNumbers,
  baseline: SizeReportBaseline,
): string {
  const lines: string[] = [
    "### Size and type cost",
    "",
    "Reported only. Deltas are against `tests/fixtures/size-report.json`, updated by hand at release prep.",
    "",
    "| Measure | Value | Delta |",
    "| --- | ---: | ---: |",
    row(
      "startup min",
      measured.startup.minBytes,
      signedDelta(measured.startup.minBytes, baseline.startup?.minBytes),
    ),
    row(
      "startup gzip",
      measured.startup.gzipBytes,
      signedDelta(measured.startup.gzipBytes, baseline.startup?.gzipBytes),
    ),
    row(
      "runtime entry min",
      measured.runtimeEntry.minBytes,
      signedDelta(measured.runtimeEntry.minBytes, baseline.runtimeEntry?.minBytes),
    ),
    row(
      "runtime entry gzip",
      measured.runtimeEntry.gzipBytes,
      signedDelta(measured.runtimeEntry.gzipBytes, baseline.runtimeEntry?.gzipBytes),
    ),
    row(
      `runtime entry cold import ms (median of ${String(REPORT_COLD_IMPORT_SAMPLES)})`,
      measured.runtimeEntry.coldImportMs.toFixed(3),
      signedDelta(measured.runtimeEntry.coldImportMs, baseline.runtimeEntry?.coldImportMs, 3),
    ),
  ];
  for (const [entry, bytes] of Object.entries(measured.connect)) {
    const base = baseline.connect?.[entry];
    lines.push(
      row(`${entry} min`, bytes.minBytes, signedDelta(bytes.minBytes, base?.minBytes)),
      row(`${entry} gzip`, bytes.gzipBytes, signedDelta(bytes.gzipBytes, base?.gzipBytes)),
    );
  }
  for (const [entry, bytes] of Object.entries(measured.adapters)) {
    const base = baseline.adapters?.[entry];
    lines.push(
      row(`${entry} min`, bytes.minBytes, signedDelta(bytes.minBytes, base?.minBytes)),
      row(`${entry} gzip`, bytes.gzipBytes, signedDelta(bytes.gzipBytes, base?.gzipBytes)),
      row(
        `${entry} incremental`,
        bytes.incrementalMinBytes,
        signedDelta(bytes.incrementalMinBytes, base?.incrementalMinBytes),
      ),
    );
  }
  lines.push(
    row(
      "CLI chunk sum",
      measured.cliChunkBytes,
      signedDelta(measured.cliChunkBytes, baseline.cliChunkBytes),
    ),
  );
  if (measured.tarballBytes === undefined) {
    lines.push("| tarball bytes | (not measured) | — |");
  } else {
    lines.push(
      row(
        "tarball bytes",
        measured.tarballBytes,
        signedDelta(measured.tarballBytes, baseline.tarballBytes),
      ),
    );
  }
  lines.push(
    "",
    "#### Type cost",
    "",
    "| Probe | Instantiations | Δ inst | Types | Δ types |",
    "| --- | ---: | ---: | ---: | ---: |",
  );
  for (const [probe, cost] of Object.entries(measured.typeCost)) {
    const base = baseline.typeCost?.[probe];
    lines.push(
      `| ${probe} | ${formatCount(cost.instantiations)} | ${signedDelta(cost.instantiations, base?.instantiations, Number.isInteger(cost.instantiations) ? 0 : 1)} | ${formatCount(cost.types)} | ${signedDelta(cost.types, base?.types, Number.isInteger(cost.types) ? 0 : 1)} |`,
    );
  }
  if (measured.notes.length > 0) {
    lines.push("", ...measured.notes.map((note) => `- ${note}`));
  }
  return `${lines.join("\n")}\n`;
}

function row(measure: string, value: number | string, delta: string): string {
  return `| ${measure} | ${typeof value === "number" ? String(value) : value} | ${delta} |`;
}

function formatCount(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1);
}

/**
 * Measures the graphs the summary names.
 *
 * A failed section is a note. The rest of the report is still written.
 *
 * @param root - Repository root
 * @returns The numbers, with notes for sections that did not measure
 */
export async function collectSizeReport(root: string): Promise<SizeReportNumbers> {
  const notes: string[] = [];
  const startup = await measureStubbedStartup(root, APP_ENTRY, "app-startup.js", [
    "postgres",
  ]).catch((error: unknown) => {
    notes.push(`startup: ${messageOf(error)}`);
    return { entry: APP_ENTRY, minBytes: 0, gzipBytes: 0, coldImportMs: 0, sources: [] };
  });
  const runtime = safeSync(
    () => measureEntry(root, RUNTIME_ENTRY, [], REPORT_COLD_IMPORT_SAMPLES),
    notes,
    "runtime entry",
    { entry: RUNTIME_ENTRY, minBytes: 0, gzipBytes: 0, coldImportMs: 0 },
  );
  const connect: Record<string, BytePair> = {};
  for (const entry of CONNECT_ENTRIES) {
    const measured = await measureStubbedStartup(
      root,
      entry.entry,
      entry.file,
      entry.external,
    ).catch((error: unknown) => {
      notes.push(`${entry.entry}: ${messageOf(error)}`);
      return undefined;
    });
    if (measured !== undefined) {
      connect[entry.entry] = { minBytes: measured.minBytes, gzipBytes: measured.gzipBytes };
    }
  }
  const adapters: Record<string, BytePair & { incrementalMinBytes: number }> = {};
  const runtimeInputs = safeSync(
    () => bundleInputBytes(root, RUNTIME_ENTRY),
    notes,
    "runtime inputs",
    undefined,
  );
  for (const entry of ADAPTER_ENTRIES) {
    const measured = safeSync(
      () => measureEntry(root, entry.entry, entry.external, 0),
      notes,
      entry.entry,
      undefined,
    );
    if (measured === undefined || runtimeInputs === undefined) continue;
    const incremental = incrementalMinBytes(
      bundleInputBytes(root, entry.entry, entry.external),
      runtimeInputs,
    );
    adapters[entry.entry] = {
      minBytes: measured.minBytes,
      gzipBytes: measured.gzipBytes,
      incrementalMinBytes: incremental,
    };
  }
  const cliChunkBytes = safeSync(() => cliChunkSum(root), notes, "CLI", 0);
  let tarballBytes: number | undefined;
  try {
    tarballBytes = (await readPacked(root)).bytes;
  } catch (error) {
    notes.push(`tarball: ${messageOf(error)}`);
  }
  const typeCost: Record<string, { instantiations: number; types: number }> = {};
  try {
    for (const line of typeCostLines(measureTypeBudgets())) {
      typeCost[line.probe] = { instantiations: line.instantiations, types: line.types };
    }
  } catch (error) {
    notes.push(`type-cost: ${messageOf(error)}`);
  }
  return {
    startup: { minBytes: startup.minBytes, gzipBytes: startup.gzipBytes },
    runtimeEntry: {
      minBytes: runtime.minBytes,
      gzipBytes: runtime.gzipBytes,
      coldImportMs: Math.round(runtime.coldImportMs * 1000) / 1000,
    },
    connect,
    adapters,
    cliChunkBytes,
    tarballBytes,
    typeCost,
    notes,
  };
}

/**
 * Sum of the files `bun build` emits for the CLI with splitting.
 *
 * This is the chunk sum. It does not follow a relative import the bundle
 * left as source text, such as `./schema.ts` inside a generated snippet.
 *
 * @param root - Repository root
 * @returns Minified bytes
 */
function cliChunkSum(root: string): number {
  const dir = mkdtempSync(join(tmpdir(), "okm-cli-"));
  try {
    const proc = Bun.spawnSync(
      [
        "bun",
        "build",
        join(root, CLI_ENTRY),
        "--target",
        "node",
        "--minify",
        "--splitting",
        "--outdir",
        dir,
        ...CLI_EXTERNALS.flatMap((name) => ["--external", name]),
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      throw new Error(proc.stderr.toString().split("\n")[0] ?? "bun build failed");
    }
    return directoryBytes(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function directoryBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path);
    total += info.isDirectory() ? directoryBytes(path) : info.size;
  }
  return total;
}

function safeSync<T>(run: () => T, notes: string[], label: string, fallback: T): T {
  try {
    return run();
  } catch (error) {
    notes.push(`${label}: ${messageOf(error)}`);
    return fallback;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error);
}

if (import.meta.main) {
  try {
    const root = repoRoot();
    const measured = await collectSizeReport(root);
    const markdown = sizeReportMarkdown(measured, readSizeReportBaseline(root));
    process.stdout.write(markdown);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary !== undefined && summary.length > 0) {
      appendFileSync(summary, `${markdown}\n`);
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
  }
}
