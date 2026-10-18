/**
 * `verify:fast` runs the static checks, then `bun test --changed`.
 */

import { expect, test } from "bun:test";

import { VERIFY_FAST_STEPS, changedTestCommand, verifyFastBase } from "./verify-fast.js";
import { repoRoot } from "./root.js";

test("the static steps are the fast loop, and tests use bun --changed", () => {
  expect(VERIFY_FAST_STEPS.map((step) => step.join(" "))).toEqual([
    "bun run format:check",
    "bun run lint",
    "bun run typecheck",
    "bun run layers-check",
    "bun run core-purity",
    "bun run bundle-purity",
    "bun run docs:check",
    "bun run readme:check",
  ]);
  const base = verifyFastBase(repoRoot());
  expect(base.length).toBeGreaterThan(0);
  expect(changedTestCommand(base)).toEqual([
    "bun",
    "test",
    `--changed=${base}`,
    "--pass-with-no-tests",
  ]);
});
