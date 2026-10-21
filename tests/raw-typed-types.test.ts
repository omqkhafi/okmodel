/**
 * A typed `raw()` literal with no `RawStatements` entry fails to compile, and the
 * error tells the author to run `okm raw sync`.
 */

import { expect, test } from "bun:test";

import { REQUIRED_COMPILER } from "../scripts/ts-range.js";
import { repoRoot } from "../scripts/root.js";

test("an unlocked literal is a type error that names okm raw sync", () => {
  const root = repoRoot();
  const run = Bun.spawnSync(
    ["bun", `${root}/${REQUIRED_COMPILER}`, "-p", "tests/fixtures/raw-negative/tsconfig.json"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const output = `${run.stdout.toString()}${run.stderr.toString()}`;
  expect(run.exitCode).not.toBe(0);
  expect(output).toContain("missing.ts(5,");
  expect(output).toContain("okm raw sync");
  expect(output).toContain(".okm/raw.lock.json");
});
