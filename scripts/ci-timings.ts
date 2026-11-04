/**
 * Writes the slowest test files of one CI job to its step summary.
 *
 * The job runs `bun test --timings=<file> --update-timings`, which writes
 * `{ "version": 1, "files": { "<path>": <ms> } }` after the run. This script
 * reads that file and appends a table of the slowest files. It never fails
 * the job: a missing or unknown file is reported in the summary and exits 0.
 *
 *   bun ./scripts/ci-timings.ts <timings.json> "<job name>"
 */

import { appendFileSync, readFileSync } from "node:fs";

/** How many files the summary lists. */
export const SLOWEST_FILES = 15;

/** One test file and its measured duration. */
export type FileTiming = {
  /** Path from the repository root, as Bun wrote it. */
  readonly file: string;
  /** Milliseconds Bun measured for the file. */
  readonly ms: number;
};

/**
 * The slowest files in a `--update-timings` payload.
 *
 * @param payload - Parsed JSON from the timings file
 * @param limit - How many files to keep
 * @returns Slowest first, or undefined when the payload is not version 1
 */
export function slowestFiles(
  payload: unknown,
  limit: number = SLOWEST_FILES,
): readonly FileTiming[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { version, files } = payload as { version?: unknown; files?: unknown };
  if (version !== 1 || typeof files !== "object" || files === null) return undefined;
  const rows: FileTiming[] = [];
  for (const [file, ms] of Object.entries(files)) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
    rows.push({ file, ms });
  }
  rows.sort((left, right) => right.ms - left.ms || left.file.localeCompare(right.file));
  return rows.slice(0, limit);
}

/**
 * Markdown for one job's summary.
 *
 * @param job - Job name, such as `test / client`
 * @param rows - From {@link slowestFiles}, or undefined when unreadable
 * @param note - Why there are no rows, when `rows` is undefined
 * @returns A heading and a table, ending in a newline
 */
export function timingsSummary(
  job: string,
  rows: readonly FileTiming[] | undefined,
  note = "no timings file",
): string {
  const heading = `### Slowest test files: ${job}\n\n`;
  if (rows === undefined || rows.length === 0) return `${heading}${note}.\n`;
  const lines = rows.map((row) => `| \`${row.file}\` | ${(row.ms / 1000).toFixed(1)} |`);
  return `${heading}| File | Seconds |\n| --- | ---: |\n${lines.join("\n")}\n`;
}

/**
 * Reads the timings file and renders the summary.
 *
 * @param path - File written by `bun test --update-timings`
 * @param job - Job name for the heading
 * @returns Markdown, never throws
 */
export function summaryFromFile(path: string, job: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return timingsSummary(job, undefined, "no timings file");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return timingsSummary(job, undefined, "timings file is not JSON");
  }
  const rows = slowestFiles(payload);
  return timingsSummary(job, rows, "timings file is not Bun version 1");
}

if (import.meta.main) {
  const [path, job = "tests"] = process.argv.slice(2);
  if (path === undefined) {
    console.error('usage: bun ./scripts/ci-timings.ts <timings.json> "<job name>"');
    process.exit(0);
  }
  const markdown = summaryFromFile(path, job);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary.length > 0) {
    try {
      appendFileSync(summary, `${markdown}\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
  process.stdout.write(markdown);
}
