/**
 * Measures a trivial type with TypeScript 7's own diagnostics.
 *
 * Runs `tsc --extendedDiagnostics` on `tests/fixtures/type-cost` and writes
 * the parsed counters as JSON. No ceilings.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./root.js";

/** Counters parsed from `tsc --extendedDiagnostics`, plus which trace flags exist. */
export type TypeCostReport = {
  /** `tsc --version`, such as `7.0.2`. */
  readonly compiler: string;
  /** Project the diagnostics were collected from, relative to the repository root. */
  readonly project: string;
  /** `Instantiations` from the diagnostic block. */
  readonly instantiations: number;
  /** `Check time` in seconds. */
  readonly checkTimeSeconds: number;
  /** `Memory used`, in kilobytes. */
  readonly memoryUsedKb: number;
  /** `Types` from the diagnostic block. */
  readonly types: number;
  /** Every `Name: value` line the compiler printed, as a number. */
  readonly fields: Readonly<Record<string, number>>;
  /** Trace-related flags present in `tsc --help --all`. */
  readonly traceOptions: readonly string[];
};

const projectRelative = "tests/fixtures/type-cost";
const traceFlags = ["generateTrace", "traceResolution"] as const;

/**
 * Runs the TypeScript 7 compiler on the trivial type project and parses its diagnostics.
 */
export function measureTypeCost(): TypeCostReport {
  const root = repoRoot();
  const project = join(root, projectRelative);
  const diagnostics = runTsc([
    "--noEmit",
    "--pretty",
    "false",
    "--extendedDiagnostics",
    "-p",
    project,
  ]);
  const fields = parseDiagnosticFields(diagnostics);
  const version = runTsc(["--version"]).match(/(\d+\.\d+\.\d+)/);
  if (version?.[1] === undefined) {
    throw new Error(`tsc --version did not report a version\n${runTsc(["--version"])}`);
  }
  return {
    compiler: version[1],
    project: projectRelative,
    instantiations: requireField(fields, "Instantiations"),
    checkTimeSeconds: requireField(fields, "Check time"),
    memoryUsedKb: requireField(fields, "Memory used"),
    types: requireField(fields, "Types"),
    fields,
    traceOptions: traceOptionsPresent(runTsc(["--help", "--all"])),
  };
}

/**
 * Writes the report as JSON under `packages/bench/results` and prints it.
 */
function writeReport(report: TypeCostReport): void {
  const results = join(repoRoot(), "packages", "bench", "results");
  mkdirSync(results, { recursive: true });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(results, "type-cost.json"), json);
  process.stdout.write(json);
}

function runTsc(args: readonly string[]): string {
  const proc = Bun.spawnSync(["bunx", "tsc", ...args], {
    cwd: repoRoot(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  if (proc.exitCode !== 0 && !args.includes("--help")) {
    throw new Error(`tsc ${args.join(" ")} exited ${String(proc.exitCode)}\n${output}`);
  }
  return output;
}

function parseDiagnosticFields(output: string): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const line of output.split("\n")) {
    const match = /^([A-Za-z][^:]*):\s+(\S+)\s*$/.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }
    fields[match[1]] = parseDiagnosticValue(match[2]);
  }
  if (Object.keys(fields).length === 0) {
    throw new Error(`tsc --extendedDiagnostics printed no counters\n${output}`);
  }
  return fields;
}

function parseDiagnosticValue(raw: string): number {
  const trimmed = raw.endsWith("K") || raw.endsWith("s") ? raw.slice(0, -1) : raw;
  const value = Number(trimmed);
  if (Number.isNaN(value)) {
    throw new Error(`tsc diagnostic value is not a number: ${raw}`);
  }
  return value;
}

function requireField(fields: Readonly<Record<string, number>>, name: string): number {
  const value = fields[name];
  if (value === undefined) {
    throw new Error(`tsc --extendedDiagnostics did not report ${name}`);
  }
  return value;
}

function traceOptionsPresent(help: string): readonly string[] {
  return traceFlags.filter((flag) => help.includes(`--${flag}`));
}

if (import.meta.main) {
  try {
    writeReport(measureTypeCost());
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
