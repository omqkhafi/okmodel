/**
 * Path filter: docs and site changes skip the runtime matrix.
 */

import { expect, test } from "bun:test";

import { runtimeRelevant, workflowsChanged } from "./ci-paths.js";

test("docs-only and site-only diffs skip the runtime matrix", () => {
  expect(runtimeRelevant(["docs/github.md"])).toBe(false);
  expect(runtimeRelevant(["site/content/docs/ai/llm.mdx", "site/package.json"])).toBe(false);
  expect(runtimeRelevant(["docs/known-limits.md", "site/content/docs/ai/llm.mdx"])).toBe(false);
});

test("any other path, or an empty diff, keeps the runtime matrix", () => {
  expect(runtimeRelevant(["docs/github.md", "src/contracts/error.ts"])).toBe(true);
  expect(runtimeRelevant(["CONTRIBUTING.md"])).toBe(true);
  expect(runtimeRelevant([".github/workflows/ci.yml"])).toBe(true);
  expect(runtimeRelevant([])).toBe(true);
});

test("workflow path changes are detected for the full tier", () => {
  expect(workflowsChanged([".github/workflows/ci.yml"])).toBe(true);
  expect(workflowsChanged([".github/workflows/windows.yml", "docs/github.md"])).toBe(true);
  expect(workflowsChanged([".github/actions/setup-bun/action.yml"])).toBe(false);
  expect(workflowsChanged(["docs/github.md"])).toBe(false);
});
