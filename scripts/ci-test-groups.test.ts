import { expect, test } from "bun:test";

import { ciTestGroups, ciTestMatrix } from "./ci-test-groups.js";
import { discoverTestFiles } from "./postgres-suite.js";
import { repoRoot } from "./root.js";

test("every test file is in exactly one CI group", () => {
  const root = repoRoot();
  const groups = ciTestGroups(root);
  const seen = new Map<string, string>();
  for (const group of groups) {
    expect(group.files.length).toBeGreaterThan(0);
    for (const file of group.files) {
      expect(seen.has(file), file).toBe(false);
      seen.set(file, group.name);
    }
  }
  expect([...seen.keys()].sort()).toEqual([...discoverTestFiles(root)]);
  const matrix = ciTestMatrix(root);
  expect(matrix.source.length).toBeGreaterThan(0);
  expect(matrix.built.length).toBeGreaterThan(0);
  expect([...matrix.source, ...matrix.built].sort()).toEqual(
    groups.map((group) => group.name).sort(),
  );
  expect(matrix.source).toContain("drivers suite");
  expect(matrix.built).toContain("drivers rest");
  expect(matrix.source).toContain("drivers-conformance");
  expect(matrix.source).toContain("topology selection");
  expect(matrix.source).toContain("topology consistency");
  expect(groups.map((group) => group.name)).toEqual([
    "reference app",
    "migrate",
    "migrate pg",
    "drivers suite",
    "drivers rest",
    "drivers-conformance",
    "rows",
    "topology selection",
    "topology consistency",
    "schema",
    "columns",
    "schema pg",
    "tenancy",
    "client",
    "client pg",
    "package",
    "contracts",
    "safety",
    "scripts",
  ]);
  // Local always-on file totals, milliseconds, after the PGlite template.
  // Docker cases in conformance and replication are skipped on this job.
  const topologyWeights: Readonly<Record<string, number>> = {
    "tests/selection.test.ts": 10_910,
    "tests/routing.test.ts": 9_300,
    "tests/consistency.test.ts": 10_920,
    "tests/topology.test.ts": 3_492,
    "tests/topology-conformance.test.ts": 2_993,
    "tests/replication.test.ts": 450,
  };
  expectBalanced(
    groups.filter((group) => group.name.startsWith("topology ")),
    topologyWeights,
  );
  // Local totals after moving the heavy conformance cases out and opening
  // PGlite from a prepared directory.
  // Local file totals (ms) after the prepared PGlite directory. Suite + error
  // on one shard, the rest on the other; conformance is a separate group.
  const driverWeights: Readonly<Record<string, number>> = {
    "tests/driver-suite.test.ts": 5_120,
    "tests/error-suite.test.ts": 3_187,
    "tests/client-close.test.ts": 4_416,
    "tests/harness.test.ts": 3_567,
    "tests/driver-test.test.ts": 95,
    "tests/compatibility-sync.test.ts": 41,
    "tests/capabilities.test.ts": 19,
    "tests/connect-floor.test.ts": 20,
    "tests/driver-capabilities-break.test.ts": 12,
    "tests/driver-error-mapping.test.ts": 9,
    "tests/driver-error.test.ts": 11,
    "tests/driver-runner.test.ts": 79,
    "tests/driver-types.test.ts": 75,
    "tests/error.test.ts": 277,
    "tests/driver-storm-pg.test.ts": 400,
    "tests/driver-conformance.test.ts": 12_109,
    "tests/compatibility.test.ts": 6_427,
  };
  expectBalanced(
    groups.filter((group) => group.name === "drivers suite" || group.name === "drivers rest"),
    driverWeights,
  );
  const conformance = groups.find((group) => group.name === "drivers-conformance");
  expect(conformance?.files).toEqual([
    "tests/compatibility.test.ts",
    "tests/driver-conformance.test.ts",
  ]);
});

function expectBalanced(
  shards: readonly { readonly name: string; readonly files: readonly string[] }[],
  weights: Readonly<Record<string, number>>,
): void {
  const loads: number[] = [];
  for (const group of shards) {
    let sum = 0;
    for (const file of group.files) {
      const weight = weights[file];
      expect(weight, file).toBeDefined();
      sum += weight ?? 0;
    }
    loads.push(sum);
  }
  const average = loads.reduce((total, load) => total + load, 0) / loads.length;
  const slowest = Math.max(...loads);
  expect(slowest).toBeLessThanOrEqual(average * 1.3);
}
