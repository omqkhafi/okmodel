/**
 * Fails when the packed tarball grows more than 400 KB over the baseline.
 *
 * The baseline is `tests/fixtures/pack-size.json`. `size` is the byte
 * length `npm pack --dry-run --json` reports for the tarball.
 *
 *   bun ./scripts/pack-size.ts
 *   bun ./scripts/pack-size.ts --update
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

/** Growth that fails the check, in bytes. */
export const PACK_SIZE_LIMIT = 400 * 1024;

/** Committed baseline. */
export const PACK_SIZE_BASELINE = "tests/fixtures/pack-size.json";

/** Baseline file. */
export type PackSizeBaseline = {
  /** Tarball size in bytes. */
  readonly bytes: number;
};

/**
 * Whether `actual` is within {@link PACK_SIZE_LIMIT} of `baseline`.
 *
 * A smaller tarball passes. Growth above the limit fails.
 *
 * @param actual - Packed tarball bytes
 * @param baseline - Committed bytes
 * @returns Problem lines
 */
export function packSizeProblems(actual: number, baseline: number): readonly string[] {
  const growth = actual - baseline;
  if (growth <= PACK_SIZE_LIMIT) return [];
  return [
    `pack-size: tarball grew by ${String(growth)} bytes (limit ${String(PACK_SIZE_LIMIT)}). Baseline ${String(baseline)}, actual ${String(actual)}. Run with --update after review.`,
  ];
}

/**
 * Reads the committed baseline.
 *
 * @param root - Repository root
 * @returns The byte count
 */
export function readPackSizeBaseline(root: string): number {
  const path = join(root, PACK_SIZE_BASELINE);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("bytes" in parsed)) {
    throw new Error(`pack-size: ${PACK_SIZE_BASELINE} has no bytes`);
  }
  const bytes = (parsed as { bytes?: unknown }).bytes;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) {
    throw new Error(`pack-size: ${PACK_SIZE_BASELINE} bytes is not a non-negative integer`);
  }
  return bytes;
}

/**
 * Writes the baseline.
 *
 * @param root - Repository root
 * @param bytes - Tarball size
 */
export function writePackSizeBaseline(root: string, bytes: number): void {
  const body: PackSizeBaseline = { bytes };
  writeFileSync(join(root, PACK_SIZE_BASELINE), `${JSON.stringify(body, null, 2)}\n`);
}

if (import.meta.main) {
  const root = repoRoot();
  const update = process.argv.includes("--update");
  const packed = await import("./pack-contract.js").then((mod) => mod.readPacked(root));
  if (update) {
    writePackSizeBaseline(root, packed.bytes);
    console.log(`pack-size: wrote ${PACK_SIZE_BASELINE} (${String(packed.bytes)} bytes)`);
  } else {
    exitOnProblems(packSizeProblems(packed.bytes, readPackSizeBaseline(root)));
    console.log(`pack-size: ${String(packed.bytes)} bytes`);
  }
}
