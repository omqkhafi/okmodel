/**
 * Heavy jobs run on main and on the nightly schedule, not on a pull request.
 */

import { expect, test } from "bun:test";

import { heavyTierRequested } from "./ci-tier.js";

test("a push and a schedule run the heavy tier", () => {
  expect(heavyTierRequested("push")).toBe(true);
  expect(heavyTierRequested("schedule")).toBe(true);
});

test("a pull request does not", () => {
  expect(heavyTierRequested("pull_request")).toBe(false);
  expect(heavyTierRequested("workflow_dispatch")).toBe(false);
});
