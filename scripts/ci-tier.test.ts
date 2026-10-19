/**
 * Full-tier rules for `gate / check`.
 */

import { expect, test } from "bun:test";

import { fullTierRequested } from "./ci-tier.js";

test("a push always requires the full tier", () => {
  expect(
    fullTierRequested({
      eventName: "push",
      fullCiLabel: false,
      workflowsChanged: false,
      title: "",
    }),
  ).toBe(true);
});

test("full-ci, release titles, and workflow path changes require the full tier", () => {
  expect(
    fullTierRequested({
      eventName: "pull_request",
      fullCiLabel: true,
      workflowsChanged: false,
      title: "fix(ci): x",
    }),
  ).toBe(true);
  expect(
    fullTierRequested({
      eventName: "pull_request",
      fullCiLabel: false,
      workflowsChanged: false,
      title: "chore(release): 0.10.0",
    }),
  ).toBe(true);
  expect(
    fullTierRequested({
      eventName: "pull_request",
      fullCiLabel: false,
      workflowsChanged: true,
      title: "chore(ci): gate",
    }),
  ).toBe(true);
});

test("an ordinary pull request without those signals stays on the fast tier", () => {
  expect(
    fullTierRequested({
      eventName: "pull_request",
      fullCiLabel: false,
      workflowsChanged: false,
      title: "chore(ci): gate",
    }),
  ).toBe(false);
  expect(
    fullTierRequested({
      eventName: "pull_request",
      fullCiLabel: false,
      workflowsChanged: false,
      title: "chore(release-notes): x",
    }),
  ).toBe(false);
});
