/**
 * pr-lint — title, closing line, labels, and milestone.
 */

import { describe, expect, test } from "bun:test";

import { lintPullRequest, type PullRequestMeta } from "./pr-lint.js";

const valid: PullRequestMeta = {
  title: "feat(runtime): route reads to a replica",
  body: "Reads follow the watermark.\n\nCloses #86\n",
  labels: ["type: feat", "area: runtime"],
  milestone: "0.5",
};

describe("lintPullRequest", () => {
  test("valid title", () => {
    expect(lintPullRequest(valid)).toEqual([]);
  });

  test("bad title", () => {
    expect(lintPullRequest({ ...valid, title: "Route reads to a replica" })).toEqual([
      "title must match type(scope): summary, where type is feat, fix, perf, docs, test, chore, refactor, security",
    ]);
  });

  test("missing Closes", () => {
    expect(lintPullRequest({ ...valid, body: "Reads follow the watermark.\n" })).toEqual([
      "body must end with Closes #N",
    ]);
  });

  test("missing type label", () => {
    expect(lintPullRequest({ ...valid, labels: ["area: runtime"] })).toEqual([
      "exactly one type: label is required, found 0",
    ]);
  });

  test("missing area label", () => {
    expect(lintPullRequest({ ...valid, labels: ["type: feat"] })).toEqual([
      "at least one area: label is required",
    ]);
  });

  test("no milestone", () => {
    expect(lintPullRequest({ ...valid, milestone: null })).toEqual(["milestone is required"]);
  });
});
