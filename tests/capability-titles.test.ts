/**
 * Proof titles ignore comments (N-116).
 */

import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectTestTitles } from "../src/tooling/capabilities/titles.js";
import { POSTGRES_FEATURES } from "../src/tooling/capabilities/postgres.js";
import { UUIDV7_POSTGRES } from "../src/dialects/pg/floor.js";

test("commented test titles are not proofs", () => {
  const root = mkdtempSync(join(tmpdir(), "okm-titles-"));
  writeFileSync(
    join(root, "x.test.ts"),
    '// test("proof:commented out")\n/* it("proof:in block comment") */\ntest("proof:real", () => {});\n',
  );
  expect([...collectTestTitles([root])].sort()).toEqual(["proof:real"]);
});

test("type.uuidv7 since reads UUIDV7_POSTGRES", () => {
  expect(POSTGRES_FEATURES["type.uuidv7"].since).toBe(String(UUIDV7_POSTGRES));
});

test("a postgresTest title is a proof title", () => {
  const root = mkdtempSync(join(tmpdir(), "okm-titles-pg-"));
  writeFileSync(
    join(root, "x.test.ts"),
    'postgresTest(gate, "proof:gated", async () => {});\n// postgresTest(gate, "proof:commented out")\npostgresTest(\n  gate,\n  "proof:split",\n);\n',
  );
  // A formatter splits a long call across lines, so a split call counts too.
  expect([...collectTestTitles([root])].sort()).toEqual(["proof:gated", "proof:split"]);
});
