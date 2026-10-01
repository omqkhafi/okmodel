/**
 * Compatibility table.
 *
 * The markdown is rendered from result records. It is not written by hand.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One conformance result. */
export type StatusRecord = {
  /** Adapter id. */
  readonly driver: string;
  /** Conformance test id. */
  readonly testId: string;
  /** What the suite recorded. */
  readonly status: "pass" | "fail" | "skip";
  /** Skip or failure reason. */
  readonly reason?: string;
};

/** File written beside the spike. */
export type ResultsFile = {
  /** Marks the file as generator output. */
  readonly generated: true;
  /** `server_version` per adapter, when the suite could read it. */
  readonly versions: Readonly<Record<string, string>>;
  /** One row per driver and test. */
  readonly records: readonly StatusRecord[];
};

const DRIVERS = ["postgresjs", "pglite", "batch-mode"] as const;

const DRIVER_LABEL: Readonly<Record<string, string>> = {
  postgresjs: "postgres.js",
  pglite: "PGlite",
  "batch-mode": "batch-mode",
};

/**
 * Merges a run into the previous file.
 *
 * Drivers that did not run keep their previous rows, so a skipped Docker
 * suite does not erase a Postgres result.
 *
 * @param previous - File on disk, if there was one
 * @param updates - Rows from this run
 * @param versions - Versions read this run
 * @param order - Test id order
 * @returns The merged file
 */
export function mergeResults(
  previous: ResultsFile | null,
  updates: readonly StatusRecord[],
  versions: Readonly<Record<string, string>>,
  order: readonly string[],
): ResultsFile {
  const merged = new Map<string, StatusRecord>();
  for (const record of previous?.records ?? []) merged.set(key(record), record);
  for (const record of updates) merged.set(key(record), record);
  const rank = new Map(order.map((id, index) => [id, index]));
  const records = [...merged.values()].sort((left, right) => {
    const byTest =
      (rank.get(left.testId) ?? order.length) - (rank.get(right.testId) ?? order.length);
    if (byTest !== 0) return byTest;
    return (
      DRIVERS.indexOf(left.driver as (typeof DRIVERS)[number]) -
      DRIVERS.indexOf(right.driver as (typeof DRIVERS)[number])
    );
  });
  return {
    generated: true,
    versions: { ...previous?.versions, ...versions },
    records,
  };
}

/**
 * Renders the compatibility table.
 *
 * @param file - Result records
 * @returns Markdown
 */
export function renderCompatibility(file: ResultsFile): string {
  const lines = [
    "# Driver compatibility",
    "",
    "Generated from conformance results. Do not edit by hand.",
    "",
    "| Driver | Server |",
    "| --- | --- |",
  ];
  for (const driver of DRIVERS) {
    const version = file.versions[driver];
    if (version === undefined) continue;
    lines.push(`| ${label(driver)} | ${version} |`);
  }
  lines.push("", "| Test | postgres.js | PGlite | batch-mode |", "| --- | --- | --- | --- |");
  const tests: string[] = [];
  for (const record of file.records) {
    if (!tests.includes(record.testId)) tests.push(record.testId);
  }
  for (const testId of tests) {
    const cells = DRIVERS.map((driver) => {
      const record = file.records.find((item) => item.driver === driver && item.testId === testId);
      return record === undefined ? "" : cell(record);
    });
    lines.push(`| ${testId} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Reads a results file.
 *
 * @param path - JSON path
 * @returns The file, or null when it is missing or unreadable
 */
export function readResults(path: string): ResultsFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isResultsFile(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Writes results and the rendered table when either changed.
 *
 * @param directory - Directory for both files
 * @param file - Merged results
 */
export function writeResults(directory: string, file: ResultsFile): void {
  mkdirSync(directory, { recursive: true });
  const jsonPath = `${directory}/results.json`;
  const markdownPath = `${directory}/COMPATIBILITY.md`;
  const json = `${JSON.stringify(file, null, 2)}\n`;
  const markdown = renderCompatibility(file);
  writeIfChanged(jsonPath, json);
  writeIfChanged(markdownPath, markdown);
}

function key(record: StatusRecord): string {
  return `${record.driver}\0${record.testId}`;
}

function label(driver: string): string {
  return DRIVER_LABEL[driver] ?? driver;
}

function cell(record: StatusRecord): string {
  if (record.status === "pass") return "pass";
  const reason = record.reason ?? record.status;
  return `${record.status}: ${reason.replaceAll("|", "/")}`;
}

function writeIfChanged(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (readFileSync(path, "utf8") === text) return;
  } catch {
    // The file is not there yet.
  }
  writeFileSync(path, text);
}

function isResultsFile(value: unknown): value is ResultsFile {
  if (typeof value !== "object" || value === null) return false;
  if (!("records" in value) || !Array.isArray(value.records)) return false;
  if (!("versions" in value) || typeof value.versions !== "object" || value.versions === null)
    return false;
  return true;
}
