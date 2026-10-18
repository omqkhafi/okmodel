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
  expect(matrix.built).toContain("drivers");
  expect(matrix.source).toContain("topology selection");
  expect(matrix.source).toContain("topology consistency");
  expect(groups.map((group) => group.name)).toEqual([
    "reference app",
    "migrate",
    "migrate pg",
    "drivers",
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
  const weights: Readonly<Record<string, number>> = {
    "tests/selection.test.ts": 10_910,
    "tests/routing.test.ts": 9_300,
    "tests/consistency.test.ts": 10_920,
    "tests/topology.test.ts": 3_492,
    "tests/topology-conformance.test.ts": 2_993,
    "tests/replication.test.ts": 450,
  };
  const shardMs = new Map<string, number>();
  for (const group of groups) {
    if (!group.name.startsWith("topology ")) continue;
    let sum = 0;
    for (const file of group.files) {
      const weight = weights[file];
      expect(weight, file).toBeDefined();
      sum += weight ?? 0;
    }
    shardMs.set(group.name, sum);
  }
  const loads = [...shardMs.values()];
  const average = loads.reduce((total, load) => total + load, 0) / loads.length;
  const slowest = Math.max(...loads);
  expect(slowest).toBeLessThanOrEqual(average * 1.3);
});
