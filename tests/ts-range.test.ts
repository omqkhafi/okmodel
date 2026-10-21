/**
 * The required typecheck covers the public surface and the consumer fixtures.
 *
 * The TypeScript 6.0.x run is `bun run ts6:check`. It is not part of `bun run check`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { repoRoot } from "../scripts/root.js";
import {
  compilerRangeNote,
  consumerFixtureFiles,
  publicSurfaceFiles,
  surfaceCoverageProblems,
} from "../scripts/ts-range.js";

const root = repoRoot();

test("the required typecheck includes the public surface and a consumer fixture", () => {
  expect(surfaceCoverageProblems(root)).toEqual([]);
  expect(publicSurfaceFiles()).toContain("src/contracts/index.ts");
  expect(consumerFixtureFiles(root)).toContain("tests/types.test-d.ts");
  expect(consumerFixtureFiles(root)).toContain("packages/spikes/src/types/shapes.test-d.ts");
  expect(consumerFixtureFiles(root)).not.toContain("tests/fixtures/expect-type/wrong.test-d.ts");
});

test("the compatibility page names TypeScript 7 and TypeScript 6.0.x", () => {
  const note = compilerRangeNote(root);
  expect(note).toMatch(/TypeScript 7\.\d+\.\d+/);
  expect(note).toMatch(/TypeScript 6\.0\.\d+/);
  expect(note).toContain("typescript-editor");
  expect(note).toContain("bun run typecheck");
  expect(note).toContain("bun run ts6:check");
  expect(note).toContain("not part of `bun run check`");
  expect(note).toContain("until 7.1");
  expect(readFileSync(join(root, "docs/compatibility.md"), "utf8")).toContain(note);
});

test("typecheck runs the required range, and check does not run the editor compiler", () => {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(scripts.scripts.typecheck).toContain("bun ./scripts/ts-range.ts");
  expect(scripts.scripts["ts6:check"]).toBe("bun ./scripts/ts-range.ts --editor");
  expect(scripts.scripts.check).not.toContain("ts6:check");
  expect(scripts.scripts).not.toHaveProperty("ts7:check");
  const source = readFileSync(join(root, "scripts/ts-range.ts"), "utf8");
  expect(source).not.toContain('from "typescript"');
  expect(source).not.toContain("native-preview");
});
