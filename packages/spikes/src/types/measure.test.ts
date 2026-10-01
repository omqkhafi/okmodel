/**
 * Locks the type-cost counters and the `tsc` transcripts.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { measureTypes } from "./measure.js";
import { collectSnapshots } from "./snapshots.js";

const spikeRoot = join(import.meta.dir, "../../types");

test("inferred and emitted counters match the recorded run", () => {
  const recorded = JSON.parse(readFileSync(join(spikeRoot, "results.json"), "utf8")) as {
    compiler: string;
    rows: readonly {
      label: string;
      instantiations: number;
      types: number;
      exitCode: number;
    }[];
    duplicateNames: readonly { count: number; exitCode: number; instantiations: number | null }[];
  };
  const fresh = measureTypes();
  expect(fresh.compiler).toBe(recorded.compiler);
  expect(fresh.rows.map(signature)).toEqual(recorded.rows.map(signature));
  expect(
    fresh.duplicateNames.map((probe) => [probe.count, probe.exitCode, probe.instantiations]),
  ).toEqual(
    recorded.duplicateNames.map((probe) => [probe.count, probe.exitCode, probe.instantiations]),
  );
});

test("tsc transcripts match the snapshots", () => {
  const dir = join(spikeRoot, "snapshots");
  const fresh = new Map(collectSnapshots().map((snapshot) => [snapshot.name, snapshot.text]));
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".txt"))
    .map((name) => name.slice(0, -4))
    .sort();
  expect([...fresh.keys()].sort()).toEqual(names);
  for (const name of names) {
    expect(fresh.get(name)).toBe(readFileSync(join(dir, `${name}.txt`), "utf8"));
  }
});

test("core column files do not mention citext", () => {
  for (const file of ["column.ts", "table.ts", "schema.ts", "generics.ts"]) {
    const text = readFileSync(join(import.meta.dir, file), "utf8").toLowerCase();
    expect(text).not.toContain("citext");
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
