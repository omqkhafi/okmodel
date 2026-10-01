/**
 * Parses `tsc --extendedDiagnostics` and runs the compiler as a process.
 *
 * The TypeScript compiler API is not imported. D111.
 */

import { join } from "node:path";

/** Counters the types spike records from one `tsc` run. */
export type Diagnostics = {
  readonly exitCode: number;
  readonly output: string;
  readonly instantiations: number;
  readonly types: number;
  readonly checkTimeSeconds: number;
  readonly memoryUsedKb: number;
  readonly totalTimeSeconds: number;
  readonly fields: Readonly<Record<string, number>>;
};

const tscBin = join(import.meta.dir, "../../../../node_modules/.bin/tsc");

/**
 * Runs the repository's `tsc` and returns combined stdout and stderr.
 *
 * The binary path is absolute so a project outside the repository still uses
 * this TypeScript, not a copy `bunx` would download.
 *
 * @param args - Arguments after `tsc`
 * @param cwd - Working directory
 * @returns Exit code and text
 */
export function runTsc(
  args: readonly string[],
  cwd: string,
): { readonly exitCode: number; readonly output: string } {
  const proc = Bun.spawnSync([tscBin, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

/**
 * Reads the diagnostic block from a successful `tsc --extendedDiagnostics` run.
 *
 * @param output - Compiler text
 * @param exitCode - Process status
 * @returns Parsed counters
 */
export function parseDiagnostics(output: string, exitCode: number): Diagnostics {
  const fields = parseFields(output);
  return {
    exitCode,
    output,
    instantiations: requireField(fields, "Instantiations"),
    types: requireField(fields, "Types"),
    checkTimeSeconds: requireField(fields, "Check time"),
    memoryUsedKb: requireField(fields, "Memory used"),
    totalTimeSeconds: requireField(fields, "Total time"),
    fields,
  };
}

/**
 * `tsc --version`, such as `7.0.2`.
 *
 * @param cwd - Directory to launch from
 * @returns The version number
 */
export function compilerVersion(cwd: string): string {
  const version = runTsc(["--version"], cwd);
  const match = /(\d+\.\d+\.\d+)/.exec(version.output);
  if (match?.[1] === undefined) {
    throw new Error(`tsc --version did not report a version\n${version.output}`);
  }
  return match[1];
}

function parseFields(output: string): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const line of output.split("\n")) {
    const match = /^([A-Za-z][^:]*):\s+(\S+)\s*$/.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }
    fields[match[1]] = parseValue(match[2]);
  }
  if (Object.keys(fields).length === 0) {
    throw new Error(`tsc --extendedDiagnostics printed no counters\n${output}`);
  }
  return fields;
}

function parseValue(raw: string): number {
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
