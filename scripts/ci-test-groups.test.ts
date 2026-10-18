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
  expect(matrix.source).toContain("topology");
  expect(groups.map((group) => group.name)).toEqual([
    "reference app",
    "migrate",
    "migrate pg",
    "drivers",
    "rows",
    "topology",
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
});
