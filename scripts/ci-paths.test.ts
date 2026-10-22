/**
 * Path filter: docs and site changes skip the runtime matrix.
 */

import { expect, test } from "bun:test";

import { postgres18Relevant, runtimeRelevant, workflowsChanged } from "./ci-paths.js";

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

test("dialects, migrate, and runtime paths run Postgres 18", () => {
  expect(postgres18Relevant(["src/dialects/pg/ddl.ts"])).toBe(true);
  expect(postgres18Relevant(["src/runtime/client.ts", "docs/github.md"])).toBe(true);
  expect(postgres18Relevant(["src/tooling/migrate/apply.ts"])).toBe(true);
  expect(postgres18Relevant(["src/adapters/pg/bunsql.ts"])).toBe(false);
  expect(postgres18Relevant(["docs/github.md"])).toBe(false);
  expect(postgres18Relevant([])).toBe(false);
});

test("workflow path changes are detected for the full tier", () => {
  expect(workflowsChanged([".github/workflows/ci.yml"])).toBe(true);
  expect(workflowsChanged([".github/workflows/windows.yml", "docs/github.md"])).toBe(true);
  expect(workflowsChanged([".github/actions/setup-bun/action.yml"])).toBe(false);
  expect(workflowsChanged(["docs/github.md"])).toBe(false);
});
