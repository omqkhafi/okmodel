/**
 * `verify:fast` runs the static checks, then `bun test --changed`.
 */

import { expect, test } from "bun:test";

import {
  VERIFY_FAST_STEPS,
  bunPinWarning,
  changedTestCommand,
  verifyFastBase,
} from "./verify-fast.js";
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

test("a different local Bun warns and the pinned version does not", () => {
  expect(bunPinWarning("1.4.2", "1.4.3")).toBe(
    "verify:fast: local Bun 1.4.2 differs from the pinned 1.4.3 in .bun-version",
  );
  expect(bunPinWarning("1.4.3", "1.4.3")).toBeUndefined();
  expect(bunPinWarning("1.4.3", "v1.4.3")).toBeUndefined();
  expect(bunPinWarning("1.4.2", "v1.4.3")).toBe(
    "verify:fast: local Bun 1.4.2 differs from the pinned v1.4.3 in .bun-version",
  );
});
