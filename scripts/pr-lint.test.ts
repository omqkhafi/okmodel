/**
 * pr-lint — the title is the only requirement.
 */

import { describe, expect, test } from "bun:test";

import {
  DEPENDABOT_LOGIN,
  lintPullRequest,
  parseConventionalTitle,
  type PullRequestMeta,
} from "./pr-lint.js";

const valid: PullRequestMeta = {
  author: "omqkhafi",
  title: "feat(runtime): route reads to a replica",
  body: "Reads follow the watermark.\n",
  labels: [],
  milestone: null,
};

const update: PullRequestMeta = {
  author: DEPENDABOT_LOGIN,
  title: "chore(deps): bump the npm group across 1 directory with 2 updates",
  body: "Bumps the npm group with 2 updates.\n",
  labels: [],
  milestone: null,
};

describe("lintPullRequest", () => {
  test("a conventional title passes without a closing line, labels, or a milestone", () => {
    expect(lintPullRequest(valid)).toEqual([]);
    expect(lintPullRequest(update)).toEqual([]);
    expect(
      lintPullRequest({
        ...valid,
        title: "fix(runtime)!: omit bound parameters by default",
      }),
    ).toEqual([]);
  });

  test("bad title", () => {
    expect(lintPullRequest({ ...valid, title: "Route reads to a replica" })).toEqual([
      "title must match type(scope): summary, where type is feat, fix, perf, docs, test, chore, refactor, security",
    ]);
  });

  test("dependabot with a bad title still fails", () => {
    expect(lintPullRequest({ ...update, title: "Bump the npm group" })).toEqual([
      "title must match type(scope): summary, where type is feat, fix, perf, docs, test, chore, refactor, security",
    ]);
  });
});

test("parseConventionalTitle reads the type and the scope", () => {
  expect(parseConventionalTitle("fix(ci): settle the gate")).toEqual({ type: "fix", scope: "ci" });
  expect(parseConventionalTitle("fix(runtime)!: omit bound parameters by default")).toEqual({
    type: "fix",
    scope: "runtime",
  });
  expect(parseConventionalTitle("not a title")).toBeUndefined();
});
