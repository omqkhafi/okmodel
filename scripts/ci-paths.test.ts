/**
 * Path filter: docs and site changes skip the runtime matrix.
 */

import { expect, test } from "bun:test";

import {
  compositionRelevant,
  examplesRelevant,
  lifecycleRelevant,
  postgres18Relevant,
  runtimeRelevant,
  packContractRelevant,
  siteTestsRelevant,
  workflowsChanged,
} from "./ci-paths.js";

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

test("tooling and dialects run the site tests", () => {
  expect(siteTestsRelevant(["src/tooling/migrate/commands.ts"])).toBe(true);
  expect(siteTestsRelevant(["src/dialects/pg/ddl.ts"])).toBe(true);
  expect(siteTestsRelevant(["src/tooling/cli.ts", "docs/github.md"])).toBe(true);
  expect(siteTestsRelevant(["src/runtime/client.ts"])).toBe(false);
  expect(siteTestsRelevant(["src/adapters/pg/postgresjs.ts"])).toBe(false);
  expect(siteTestsRelevant(["site/lib/hero-derived.json"])).toBe(false);
  expect(siteTestsRelevant(["docs/errors/OKM1510.md"])).toBe(false);
  expect(siteTestsRelevant([])).toBe(false);
});

test("examples, runtime, dialects, and Frameworks pages run the examples job", () => {
  expect(examplesRelevant(["examples/express/src/server.ts"])).toBe(true);
  expect(examplesRelevant(["src/runtime/client.ts"])).toBe(true);
  expect(examplesRelevant(["src/dialects/pg/ddl.ts"])).toBe(true);
  expect(examplesRelevant(["site/content/docs/frameworks/nextjs.mdx"])).toBe(true);
  expect(examplesRelevant(["scripts/examples-test.ts"])).toBe(true);
  expect(examplesRelevant(["site/content/docs/start/installation.mdx"])).toBe(false);
  expect(examplesRelevant(["docs/github.md"])).toBe(false);
  expect(examplesRelevant([])).toBe(false);
});

test("packed paths, src, scripts, and package.json run the pack contract", () => {
  expect(packContractRelevant(["src/runtime/client.ts"])).toBe(true);
  expect(packContractRelevant(["scripts/pack-contract.ts"])).toBe(true);
  expect(packContractRelevant(["package.json"])).toBe(true);
  expect(packContractRelevant(["src/dialects/pg/ddl.ts", "docs/github.md"])).toBe(true);
  expect(packContractRelevant(["docs/errors/OKM9999.md"])).toBe(true);
  expect(packContractRelevant(["docs/github.md"])).toBe(true);
  expect(packContractRelevant(["schemas/config.json"])).toBe(true);
  expect(packContractRelevant(["skills/okm/SKILL.md"])).toBe(true);
  expect(packContractRelevant(["README.md"])).toBe(true);
  expect(packContractRelevant(["LICENSE"])).toBe(true);
  expect(packContractRelevant(["LICENSE.md"])).toBe(true);
  expect(packContractRelevant(["readme.md"])).toBe(true);
  expect(packContractRelevant(["CHANGELOG.md"])).toBe(true);
  expect(packContractRelevant(["site/README.md"])).toBe(false);
  expect(packContractRelevant(["site/package.json"])).toBe(false);
  expect(packContractRelevant(["tests/fixtures/pack-contract.snap.json"])).toBe(false);
  expect(packContractRelevant([])).toBe(false);
});

test("dialects, runtime, and tests/composition run the composition cases", () => {
  expect(compositionRelevant(["src/dialects/pg/ddl.ts"])).toBe(true);
  expect(compositionRelevant(["src/runtime/client.ts"])).toBe(true);
  expect(compositionRelevant(["tests/composition/composition-pg.test.ts"])).toBe(true);
  expect(compositionRelevant(["src/tooling/migrate/apply.ts"])).toBe(false);
  expect(compositionRelevant(["docs/github.md"])).toBe(false);
  expect(compositionRelevant([])).toBe(false);
});

test("dialects, migrate, and tests/lifecycle run the lifecycle property", () => {
  expect(lifecycleRelevant(["src/dialects/pg/ddl.ts"])).toBe(true);
  expect(lifecycleRelevant(["src/tooling/migrate/apply.ts"])).toBe(true);
  expect(lifecycleRelevant(["tests/lifecycle/lifecycle-pg.test.ts"])).toBe(true);
  expect(lifecycleRelevant(["src/runtime/client.ts"])).toBe(false);
  expect(lifecycleRelevant(["docs/github.md"])).toBe(false);
  expect(lifecycleRelevant([])).toBe(false);
});
