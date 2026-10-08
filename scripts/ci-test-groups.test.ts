import { expect, test } from "bun:test";

import { ciTestGroups } from "./ci-test-groups.js";
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
  expect([...seen.keys()].sort()).toEqual(discoverTestFiles(root));
  expect(groups.map((group) => group.name)).toEqual([
    "reference app",
    "migrate",
    "runtime",
    "schema",
    "client",
    "tooling",
    "scripts",
  ]);
});
