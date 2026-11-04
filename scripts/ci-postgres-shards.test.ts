/**
 * Postgres suite shards run every file that needs Postgres once, and the CI
 * groups run every file.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  POSTGRES_BUILD_SHARD,
  POSTGRES_SHARDS,
  assignPostgresShards,
  isPostgresShard,
  parsePostgresShard,
  postgresFileNeedsBuild,
  postgresHeavyFiles,
  postgresShards,
  postgresTestFiles,
} from "./ci-postgres-shards.js";
import { ciTestGroups } from "./ci-test-groups.js";
import { discoverTestFiles } from "./postgres-suite.js";
import { repoRoot } from "./root.js";

/** The four longest shard files on Postgres 17 (134s, 85s, 69s, 66s). */
const LONGEST = [
  "tests/isolation.property.test.ts",
  "tests/tx-suite.test.ts",
  "tests/compatibility.test.ts",
  "tests/postgres-kill-storm-pg.test.ts",
] as const;

test("every test file is in a group or a shard, none in neither", () => {
  const root = repoRoot();
  const files = discoverTestFiles(root);
  const postgres = new Set(postgresTestFiles(root, files));
  const shards = postgresShards(root, files);
  const shardOf = new Map<string, string>();
  for (const group of shards) {
    expect(group.files.length).toBeGreaterThan(0);
    for (const file of group.files) {
      expect(shardOf.has(file), file).toBe(false);
      expect(postgres.has(file), file).toBe(true);
      shardOf.set(file, group.name);
    }
  }
  expect([...shardOf.keys()].sort()).toEqual([...postgres].sort());
  expect(shards.map((group) => group.name)).toEqual([...POSTGRES_SHARDS]);
  const grouped = new Set(ciTestGroups(root).flatMap((group) => group.files));
  for (const file of files) {
    expect(grouped.has(file) || shardOf.has(file), file).toBe(true);
  }
});

test("adding or deleting one file moves no other file", () => {
  const root = repoRoot();
  const files = postgresTestFiles(root, discoverTestFiles(root));
  const shardOf = (groups: ReturnType<typeof assignPostgresShards>): Map<string, string> =>
    new Map(groups.flatMap((group) => group.files.map((file) => [file, group.name] as const)));
  const all = shardOf(assignPostgresShards(files));
  for (const removed of files) {
    const rest = shardOf(assignPostgresShards(files.filter((file) => file !== removed)));
    for (const [file, name] of rest) expect(all.get(file), `${removed} moved ${file}`).toBe(name);
  }
  const added = shardOf(assignPostgresShards([...files, "tests/zz-new-pg.test.ts"]));
  for (const [file, name] of all) expect(added.get(file), file).toBe(name);
});

test("the four longest suite files sit on four shards", () => {
  const root = repoRoot();
  const groups = postgresShards(root, discoverTestFiles(root));
  const shards = LONGEST.map((file) => groups.find((group) => group.files.includes(file))?.name);
  expect(new Set(shards).size).toBe(LONGEST.length);
});

test("dist files share the build shard and heavy pins name Postgres files", () => {
  const root = repoRoot();
  const files = postgresTestFiles(root, discoverTestFiles(root));
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

test("a file needs Postgres when its import closure reads REQUIRE_DOCKER", () => {
  const root = mkdtempSync(join(tmpdir(), "okm-shards-"));
  const write = (path: string, body: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  try {
    write(
      "packages/harness/package.json",
      JSON.stringify({ name: "@okmodel/harness", exports: { "./gate": "./src/gate.ts" } }),
    );
    write("packages/harness/src/gate.ts", 'export const on = process.env.REQUIRE_DOCKER === "1";');
    write("packages/harness/src/helper.ts", 'export * from "./gate.js";');
    write("packages/harness/src/pglite.ts", "export const pglite = 1;");
    write("tests/direct.test.ts", 'import { on } from "../packages/harness/src/gate.js";');
    write("tests/through.test.ts", 'import { on } from "./util/load.js";');
    write(
      "tests/util/load.ts",
      'export const load = () => import("../../packages/harness/src/helper.js");',
    );
    write("tests/workspace.test.ts", 'import { on } from "@okmodel/harness/gate";');
    write("tests/reads.test.ts", 'if (process.env.REQUIRE_DOCKER !== "1") {}');
    write("tests/pglite.test.ts", 'import { pglite } from "../packages/harness/src/pglite.js";');
    write("tests/typed.test.ts", 'import type { on } from "../packages/harness/src/gate.js";');
    write("tests/cycle-a.test.ts", 'import "./cycle-b.js";');
    write("tests/cycle-b.ts", 'import "./cycle-a.test.js";');
    const files = [
      "tests/cycle-a.test.ts",
      "tests/direct.test.ts",
      "tests/pglite.test.ts",
      "tests/reads.test.ts",
      "tests/through.test.ts",
      "tests/typed.test.ts",
      "tests/workspace.test.ts",
    ];
    expect(postgresTestFiles(root, files)).toEqual([
      "tests/direct.test.ts",
      "tests/reads.test.ts",
      "tests/through.test.ts",
      "tests/workspace.test.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
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
