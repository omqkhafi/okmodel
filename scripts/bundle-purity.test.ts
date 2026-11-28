/**
 * The runtime graph rejects a `node:` specifier that is not an exception.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NODE_SPECIFIER_EXCEPTIONS,
  nodeSpecifierProblems,
  nodeSpecifiersInGraph,
} from "./bundle-purity.js";
import { repoRoot } from "./root.js";

test("the runtime graph has no unexplained node: specifier", () => {
  expect(nodeSpecifierProblems(repoRoot())).toEqual([]);
});

test("the only node: exceptions are the driver sockets and createRequire", () => {
  expect([...NODE_SPECIFIER_EXCEPTIONS.keys()].sort()).toEqual([
    "adapters/pg/nodepostgres.ts",
    "adapters/pg/postgresjs.ts",
    "dialects/pg/catalog-require.js",
  ]);
  expect(NODE_SPECIFIER_EXCEPTIONS.has("runtime/watch.ts")).toBe(false);
  expect(NODE_SPECIFIER_EXCEPTIONS.get("adapters/pg/postgresjs.ts")?.has("node:net")).toBe(true);
  expect(NODE_SPECIFIER_EXCEPTIONS.get("adapters/pg/nodepostgres.ts")?.has("node:net")).toBe(true);
  expect(NODE_SPECIFIER_EXCEPTIONS.get("dialects/pg/catalog-require.js")?.has("node:module")).toBe(
    true,
  );
});

test("a dynamic node: import in a reached runtime file fails", () => {
  const root = mkdtempSync(join(tmpdir(), "okm-node-spec-"));
  try {
    mkdirSync(join(root, "src/runtime"), { recursive: true });
    writeFileSync(
      join(root, "src/runtime/entry.ts"),
      `export async function load(): Promise<unknown> {\n  return import("node:async_hooks");\n}\n`,
    );
    const problems = nodeSpecifiersInGraph(root, ["src/runtime/entry.ts"]);
    expect(problems).toEqual(["bundle-purity: src/runtime/entry.ts imports node:async_hooks"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
