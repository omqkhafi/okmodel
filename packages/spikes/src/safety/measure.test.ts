/**
 * Locks tagged-operator type cost. Runtime samples are checked for shape only.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { measureSafety } from "./measure.js";

const spikeRoot = join(import.meta.dir, "../../safety");

test("tagged operator counters match the recorded run", () => {
  const recorded = JSON.parse(readFileSync(join(spikeRoot, "results.json"), "utf8")) as {
    compiler: string;
    rows: readonly {
      label: string;
      instantiations: number;
      types: number;
      exitCode: number;
    }[];
  };
  const fresh = measureSafety();
  expect(fresh.compiler).toBe(recorded.compiler);
  expect(fresh.rows.map(signature)).toEqual(recorded.rows.map(signature));
  for (const sample of fresh.runtime) {
    expect(sample.meanUs).toBeGreaterThan(0);
    expect(sample.p99Us).toBeGreaterThanOrEqual(sample.meanUs);
    console.log(
      JSON.stringify({
        event: "safety-runtime",
        label: sample.label,
        meanUs: round(sample.meanUs),
        p99Us: round(sample.p99Us),
      }),
    );
  }
});

function signature(row: {
  label: string;
  instantiations: number;
  types: number;
  exitCode: number;
}): string {
  return `${row.label}:${String(row.instantiations)}:${String(row.types)}:${String(row.exitCode)}`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
