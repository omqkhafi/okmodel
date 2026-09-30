import { expect, test } from "bun:test";
import { join } from "node:path";

import { checkCompilerApi } from "../scripts/compiler-api.js";
import { checkCorePurity } from "../scripts/core-purity.js";
import { checkDocs } from "../scripts/docs-check.js";
import { checkLayers } from "../scripts/layers-check.js";
import { checkReleaseDirs } from "../scripts/release-check.js";
import { repoRoot } from "../scripts/root.js";
import { checkDistSize } from "../scripts/size.js";

const root = repoRoot();
const fixtures = join(root, "tests", "fixtures");

test("layers-check fails when an import goes upward, including import type", () => {
  const problems = checkLayers(join(fixtures, "layers", "upward"));
  expect(problems.some((problem) => problem.includes("bad.ts"))).toBe(true);
  expect(problems.some((problem) => problem.includes("type-only.ts"))).toBe(true);
});

test("layers-check fails when an adapter imports a dialect", () => {
  const problems = checkLayers(join(fixtures, "layers", "adapter-dialect"));
  expect(problems.some((problem) => problem.includes("adapters/bad.ts"))).toBe(true);
});

test("layers-check allows a downward import", () => {
  expect(checkLayers(join(fixtures, "layers", "downward"))).toEqual([]);
});

test("layers-check accepts the repository source", () => {
  expect(checkLayers(join(root, "src"))).toEqual([]);
});

test("core-purity fails on a node import in the core", () => {
  const problems = checkCorePurity({
    root: join(fixtures, "core-purity", "node-import"),
  });
  expect(problems.some((problem) => problem.includes("node:fs"))).toBe(true);
});

test("core-purity fails on runtime dependencies", () => {
  const problems = checkCorePurity({
    root: join(fixtures, "core-purity", "dependencies"),
    packageJsonPath: join(fixtures, "core-purity", "dependencies", "package.json"),
  });
  expect(problems.some((problem) => problem.includes("left-pad"))).toBe(true);
});

test("core-purity allows node imports in tooling and an empty dependency list", () => {
  const problems = checkCorePurity({
    root: join(fixtures, "core-purity", "clean"),
    packageJsonPath: join(fixtures, "core-purity", "clean", "package.json"),
  });
  expect(problems).toEqual([]);
});

test("core-purity accepts the repository", () => {
  expect(
    checkCorePurity({
      root: join(root, "src"),
      packageJsonPath: join(root, "package.json"),
    }),
  ).toEqual([]);
});

test("docs:check accepts a directory whose links, sections, and decisions resolve", () => {
  expect(checkDocs(join(fixtures, "docs", "ok"))).toEqual([]);
});

test("docs:check fails on a broken relative link", () => {
  const problems = checkDocs(join(fixtures, "docs", "bad-link"));
  expect(problems.some((problem) => problem.includes("missing.md"))).toBe(true);
});

test("docs:check fails on an unknown section reference", () => {
  const problems = checkDocs(join(fixtures, "docs", "bad-section"));
  expect(problems.some((problem) => problem.includes("§9.9"))).toBe(true);
});

test("docs:check fails on an unknown decision", () => {
  const problems = checkDocs(join(fixtures, "docs", "bad-decision"));
  expect(problems.some((problem) => problem.includes("D404"))).toBe(true);
});

test("docs:check accepts the repository docs", () => {
  expect(checkDocs(join(root, "docs"))).toEqual([]);
});

test("compiler-api check fails on a typescript import", () => {
  const problems = checkCompilerApi([join(fixtures, "compiler-api")]);
  expect(problems.some((problem) => problem.includes("typescript"))).toBe(true);
});

test("compiler-api check accepts the repository", () => {
  expect(
    checkCompilerApi([
      join(root, "src"),
      join(root, "scripts"),
      join(root, "tests"),
      join(root, "packages", "harness"),
      join(root, "packages", "bench"),
    ]),
  ).toEqual([]);
});

test("size check fails above the ceiling and passes under it", () => {
  const dir = join(fixtures, "size");
  expect(checkDistSize(dir, 8).length).toBeGreaterThan(0);
  expect(checkDistSize(dir, 1000)).toEqual([]);
});

const releaseFixtures = join(fixtures, "release-check");

test("release check fails when the version and Unreleased notes are unchanged", () => {
  const problems = checkReleaseDirs(
    join(releaseFixtures, "unchanged", "base"),
    join(releaseFixtures, "unchanged", "head"),
  );
  expect(problems.some((problem) => problem.includes("equals the base branch"))).toBe(true);
  expect(problems.some((problem) => problem.includes("no new lines"))).toBe(true);
});

test("release check fails when the version matches even if Unreleased gained a line", () => {
  const problems = checkReleaseDirs(
    join(releaseFixtures, "same-version", "base"),
    join(releaseFixtures, "same-version", "head"),
  );
  expect(problems.some((problem) => problem.includes("equals the base branch"))).toBe(true);
  expect(problems.some((problem) => problem.includes("no new lines"))).toBe(false);
});

test("release check fails when the version moved but Unreleased did not", () => {
  const problems = checkReleaseDirs(
    join(releaseFixtures, "version-only", "base"),
    join(releaseFixtures, "version-only", "head"),
  );
  expect(problems).toEqual(["changelog.md has no new lines under ## Unreleased"]);
});

test("release check accepts a new Unreleased line and a new version", () => {
  expect(
    checkReleaseDirs(
      join(releaseFixtures, "notes", "base"),
      join(releaseFixtures, "notes", "head"),
    ),
  ).toEqual([]);
});

test("release check accepts a release that promotes Unreleased", () => {
  expect(
    checkReleaseDirs(
      join(releaseFixtures, "release", "base"),
      join(releaseFixtures, "release", "head"),
    ),
  ).toEqual([]);
});

test("release check rejects an emptied Unreleased that is not the suffix drop", () => {
  const problems = checkReleaseDirs(
    join(releaseFixtures, "not-release", "base"),
    join(releaseFixtures, "not-release", "head"),
  );
  expect(problems).toEqual(["changelog.md has no new lines under ## Unreleased"]);
});
