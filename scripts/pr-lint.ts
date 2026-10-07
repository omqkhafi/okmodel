/**
 * Checks a pull request against the GitHub standard in `docs/github.md`.
 *
 * The workflow checks out the base branch and passes a pull request number.
 * This file reads the pull request metadata from the API. It does not read
 * the pull request's files.
 *
 * Usage:
 *   bun ./scripts/pr-lint.ts --pr <number>
 */

import { parseArgs } from "node:util";

import { exitOnProblems } from "./report.js";

/** Types allowed in a `type(scope): summary` title and as a `type:` label. */
export const TITLE_TYPES = [
  "feat",
  "fix",
  "perf",
  "docs",
  "test",
  "chore",
  "refactor",
  "security",
] as const;

const TITLE = new RegExp(
  `^(?:${TITLE_TYPES.join("|")})\\([a-z][a-z0-9]*(?:-[a-z0-9]+)*\\): \\S(?:.*\\S)?$`,
);

/** Pull request fields the standard checks. Labels are names, not ids. */
export type PullRequestMeta = {
  /** The pull request title. */
  readonly title: string;
  /** The pull request body. Empty when GitHub has none. */
  readonly body: string;
  /** Label names currently on the pull request. */
  readonly labels: readonly string[];
  /** Milestone title, or null when none is set. */
  readonly milestone: string | null;
};

/**
 * Problems for one pull request. Empty when it matches the standard.
 *
 * @param pr - Title, body, label names, and milestone title
 * @returns Actionable problem lines, in check order
 */
export function lintPullRequest(pr: PullRequestMeta): readonly string[] {
  const problems: string[] = [];
  if (!TITLE.test(pr.title)) {
    problems.push(`title must match type(scope): summary, where type is ${TITLE_TYPES.join(", ")}`);
  }
  if (!closesIssue(pr.body)) {
    problems.push("body must end with Closes #N");
  }
  const types = pr.labels.filter((label) => label.startsWith("type: "));
  if (types.length !== 1) {
    problems.push(`exactly one type: label is required, found ${String(types.length)}`);
  }
  if (!pr.labels.some((label) => label.startsWith("area: "))) {
    problems.push("at least one area: label is required");
  }
  if (pr.milestone === null || pr.milestone.length === 0) {
    problems.push("milestone is required");
  }
  return problems;
}

/**
 * The last non-empty line is `Closes #N`.
 *
 * @param body - Pull request body
 * @returns Whether the body ends with a closing line
 */
function closesIssue(body: string): boolean {
  const lines = body.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const last = lines[lines.length - 1] ?? "";
  return /^Closes #\d+$/.test(last.trim());
}

/**
 * Reads one pull request and returns its lint problems.
 *
 * @param repo - `owner/name`
 * @param number - Pull request number
 * @param token - A token that can read pull requests
 * @returns Problem lines from {@link lintPullRequest}
 */
async function lintNumber(repo: string, number: number, token: string): Promise<readonly string[]> {
  const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${String(number)}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub pull ${String(number)} returned ${String(response.status)}`);
  }
  const payload: unknown = await response.json();
  return lintPullRequest(pullRequestMeta(payload));
}

/**
 * Narrows a pulls API payload to the fields the linter reads.
 *
 * @param payload - JSON from `GET /repos/{owner}/{repo}/pulls/{n}`
 * @returns Title, body, label names, and milestone title
 */
function pullRequestMeta(payload: unknown): PullRequestMeta {
  if (!isRecord(payload) || typeof payload.title !== "string") {
    throw new Error("GitHub pull payload has no title");
  }
  const body = payload.body;
  if (body !== null && typeof body !== "string") {
    throw new Error("GitHub pull payload body is not a string");
  }
  if (!Array.isArray(payload.labels)) {
    throw new Error("GitHub pull payload has no labels");
  }
  const labels: string[] = [];
  for (const label of payload.labels) {
    if (!isRecord(label) || typeof label.name !== "string") {
      throw new Error("GitHub pull payload label has no name");
    }
    labels.push(label.name);
  }
  const milestone = payload.milestone;
  let milestoneTitle: string | null;
  if (milestone === null) {
    milestoneTitle = null;
  } else if (isRecord(milestone) && typeof milestone.title === "string") {
    milestoneTitle = milestone.title;
  } else {
    throw new Error("GitHub pull payload milestone has no title");
  }
  return {
    title: payload.title,
    body: body ?? "",
    labels,
    milestone: milestoneTitle,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: { pr: { type: "string" } },
      args: process.argv.slice(2),
    });
    const raw = values.pr;
    const number = raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isInteger(number) || number < 1) {
      console.error("[pr-lint] Usage: bun ./scripts/pr-lint.ts --pr <number>");
      process.exit(2);
    }
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (token === undefined || token.length === 0) {
      console.error("[pr-lint] GH_TOKEN or GITHUB_TOKEN is required");
      process.exit(2);
    }
    const repo = process.env.GITHUB_REPOSITORY ?? "omqkhafi/okmodel";
    const problems = await lintNumber(repo, number, token);
    exitOnProblems(problems);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pr-lint] ${message}`);
    process.exit(1);
  }
}
