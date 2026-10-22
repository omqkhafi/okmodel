/**
 * One open issue tracks failures after merge.
 */

import { expect, test } from "bun:test";

import { CI_FAILURE_TITLE, failedJobs, parseJobResults, pickOpenIssue } from "./ci-issue.js";

test("failure and cancelled count, success and skipped do not", () => {
  expect(
    failedJobs([
      { name: "lint", result: "success" },
      { name: "suite", result: "failure" },
      { name: "tarball", result: "cancelled" },
      { name: "attest", result: "skipped" },
    ]),
  ).toEqual(["suite", "tarball"]);
});

test("an open issue with the stable title is reused", () => {
  expect(
    pickOpenIssue(
      [
        { number: 4, title: "something else" },
        { number: 9, title: CI_FAILURE_TITLE },
      ],
      CI_FAILURE_TITLE,
    ),
  ).toBe(9);
  expect(pickOpenIssue([{ number: 4, title: "other" }], CI_FAILURE_TITLE)).toBeUndefined();
});

test("parseJobResults ignores flags", () => {
  expect(parseJobResults(["--event", "lint=failure"])).toEqual([
    { name: "lint", result: "failure" },
  ]);
  expect(() => parseJobResults(["lint="])).toThrow(/usage/);
});
