/**
 * Request-time code must not read the repository: on Vercel the function has
 * only `site/`, and `repoRoot()` throws there (every page answered 500).
 */

import { expect, test } from "bun:test";

import { forbiddenReaches, REQUEST_TIME_ENTRIES } from "../scripts/request-time";

for (const entry of REQUEST_TIME_ENTRIES) {
  test(`${entry} does not reach lib/repo.ts, lib/markdown-source.ts, or node:fs`, () => {
    const chains = forbiddenReaches(entry).map((hit) => hit.chain.join(" -> "));
    expect(chains).toEqual([]);
  });
}

test("the import walk follows aliases and finds a reach", () => {
  const chains = forbiddenReaches("lib/url-contract.ts").map((hit) => hit.chain.at(-1));
  expect(chains).toContain("node:fs");
  expect(chains).toContain("lib/repo.ts");
});
