/**
 * Postgres suite shards cover every discovered file once.
 */

import { expect, test } from "bun:test";

import {
  POSTGRES_BUILD_SHARD,
  POSTGRES_SHARDS,
  assignPostgresShards,
  isPostgresShard,
  parsePostgresShard,
  postgresFileNeedsBuild,
  postgresHeavyFiles,
} from "./ci-postgres-shards.js";
import { discoverTestFiles } from "./postgres-suite.js";
import { repoRoot } from "./root.js";

const LONGEST = [
  "tests/isolation.property.test.ts",
  "tests/selection.test.ts",
  "tests/consistency.test.ts",
  "tests/tx-suite.test.ts",
] as const;

test("every test file is in exactly one Postgres shard", () => {
  const root = repoRoot();
  const files = discoverTestFiles(root);
  const groups = assignPostgresShards(files);
  const seen = new Map<string, string>();
  for (const group of groups) {
    expect(group.files.length).toBeGreaterThan(0);
    for (const file of group.files) {
      expect(seen.has(file), file).toBe(false);
      seen.set(file, group.name);
    }
  }
  expect([...seen.keys()].sort()).toEqual([...files]);
  expect(groups.map((group) => group.name)).toEqual([...POSTGRES_SHARDS]);
});

test("the four longest suite files sit on four shards", () => {
  const groups = assignPostgresShards(discoverTestFiles(repoRoot()));
  const shards = LONGEST.map((file) => groups.find((group) => group.files.includes(file))?.name);
  expect(new Set(shards).size).toBe(LONGEST.length);
});

test("dist files share the build shard and heavy pins name real files", () => {
  const files = discoverTestFiles(repoRoot());
  const groups = assignPostgresShards(files);
  const build = groups.find((group) => group.name === POSTGRES_BUILD_SHARD);
  expect(build?.needsBuild).toBe(true);
  for (const group of groups) {
    if (group.name === POSTGRES_BUILD_SHARD) continue;
    expect(group.needsBuild).toBe(false);
    expect(group.files.some((file) => postgresFileNeedsBuild(file))).toBe(false);
  }
  const have = new Set(files);
  for (const file of postgresHeavyFiles()) {
    expect(have.has(file), file).toBe(true);
    expect(postgresFileNeedsBuild(file), file).toBe(false);
  }
  for (const file of files) {
    if (!postgresFileNeedsBuild(file)) continue;
    expect(build?.files.includes(file), file).toBe(true);
  }
});

test("parsePostgresShard accepts a shard and refuses anything else", () => {
  expect(parsePostgresShard(["bun", "postgres-suite.ts"])).toBeUndefined();
  expect(parsePostgresShard(["bun", "postgres-suite.ts", "--shard", "isolation"])).toBe(
    "isolation",
  );
  expect(isPostgresShard("tx")).toBe(true);
  expect(isPostgresShard("15")).toBe(false);
  expect(() => parsePostgresShard(["bun", "postgres-suite.ts", "--shard"])).toThrow(/usage/);
  expect(() => parsePostgresShard(["bun", "postgres-suite.ts", "--shard", "nope"])).toThrow(
    /usage/,
  );
});
