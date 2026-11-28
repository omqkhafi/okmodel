/**
 * `since` follows the file at `v0.10.6`, not registry keys.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FRONTMATTER_EXEMPT } from "./frontmatter-exempt.js";
import {
  pagesWithoutSince,
  renameDestinations,
  sinceChanges,
  sinceTargets,
  targetSince,
} from "./docs-since.js";
import { repoRoot } from "./root.js";

/** Pages that existed at v0.10.6 and were marked 0.11 from registry keys. */
const EXISTED = [
  "schema/checks.mdx",
  "schema/extensions.mdx",
  "schema/number-columns.mdx",
  "schema/references.mdx",
  "schema/views.mdx",
] as const;

/** Pages added after v0.10.6 that were left on 0.10. */
const ADDED = [
  "schema/policies.mdx",
  "schema/range-types.mdx",
  "start/cheat-sheet.mdx",
  "start/first-query.mdx",
  "start/i-want-to.mdx",
  "start/production.mdx",
] as const;

test("a new file is 0.11 and an existing file keeps its value", () => {
  expect(targetSince(false, "0.10")).toBe("0.11");
  expect(targetSince(false, "0.11")).toBe("0.11");
  expect(targetSince(true, "0.10")).toBe("0.10");
  expect(targetSince(true, "0.9")).toBe("0.9");
  expect(targetSince(true, "0.11")).toBe("0.10");
});

test("git rename destinations keep the old path", () => {
  const map = renameDestinations(
    "M\tsite/content/docs/schema/checks.mdx\nR095\tsite/content/docs/old.mdx\tsite/content/docs/schema/moved.mdx\nA\tsite/content/docs/start/production.mdx\n",
  );
  expect(map.get("site/content/docs/schema/moved.mdx")).toBe("site/content/docs/old.mdx");
  expect(map.size).toBe(1);
});

test("the eleven pages follow file existence at v0.10.6", () => {
  const targets = sinceTargets(repoRoot());
  for (const path of EXISTED) expect(targets.get(path), path).toBe("0.10");
  for (const path of ADDED) expect(targets.get(path), path).toBe("0.11");
  const docs = join(repoRoot(), "site/content/docs");
  for (const path of [...EXISTED, ...ADDED]) {
    const text = readFileSync(join(docs, path), "utf8");
    const since = /^since:\s*"([^"]+)"/m.exec(text)?.[1];
    expect(since, path).toBe(targets.get(path));
  }
  expect(sinceChanges(repoRoot())).toEqual([]);
});

test("pages with no since stay off the derivation", () => {
  const missing = pagesWithoutSince(repoRoot());
  const exempt = new Set<string>(FRONTMATTER_EXEMPT);
  expect(missing.length).toBeGreaterThan(0);
  for (const path of missing) expect(exempt.has(path), path).toBe(true);
});
