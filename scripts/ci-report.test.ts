/**
 * CI report math: durations, the critical path, and why a push failed.
 */

import { expect, test } from "bun:test";

import {
  type AttemptSnapshot,
  type BaselineInput,
  criticalPath,
  elapsedSeconds,
  kindFor,
  kindsOf,
  median,
  parseJobs,
  parseRun,
  percentile,
  pushRounds,
  renderBaseline,
  type WorkflowRun,
} from "./ci-report.js";

const RUN: WorkflowRun = {
  id: 1,
  name: "CI",
  attempt: 1,
  event: "push",
  conclusion: "success",
  createdAt: "2026-10-18T10:25:44Z",
  runStartedAt: "2026-10-18T10:25:50Z",
  updatedAt: "2026-10-18T10:28:53Z",
  headSha: "abc",
  url: "https://example.test/1",
};

test("elapsed seconds round to the nearest second", () => {
  expect(elapsedSeconds("2026-10-18T10:25:44Z", "2026-10-18T10:28:52Z")).toBe(188);
  expect(elapsedSeconds("2026-10-18T10:25:44Z", "2026-10-18T10:25:44Z")).toBe(0);
  expect(elapsedSeconds("not-a-date", "2026-10-18T10:25:44Z")).toBeUndefined();
  expect(elapsedSeconds("2026-10-18T10:28:52Z", "2026-10-18T10:25:44Z")).toBeUndefined();
});

test("median and p90", () => {
  expect(median([])).toBeUndefined();
  expect(median([4])).toBe(4);
  expect(median([1, 9, 3])).toBe(3);
  expect(median([1, 2, 3, 4])).toBe(3);
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
});

test("the long pole is the job the gate waited on, not attest", () => {
  const path = criticalPath(RUN, [
    job("attest / measure", "10:28:50Z", "10:29:40Z"),
    job("test / migrate", "10:25:47Z", "10:28:40Z"),
    job("lint / static", "10:25:48Z", "10:26:10Z"),
    job("label / paths", "10:25:47Z", "10:25:55Z"),
    job("gate / check", "10:28:45Z", "10:28:52Z"),
    job("suite", "10:25:45Z", "10:25:45Z", "skipped"),
  ]);
  expect(path).toEqual({
    queueSeconds: 6,
    gateWallSeconds: 188,
    runWallSeconds: 189,
    gateSeconds: 7,
    longPole: "test / migrate",
    longPoleSeconds: 173,
  });
});

test("a failed step is classified before the job name", () => {
  expect(kindFor("lint / static", "Format")).toBe("format/lint");
  expect(kindFor("lint / static", "Lint")).toBe("format/lint");
  expect(kindFor("lint / static", "Layers")).toBe("other");
  expect(kindFor("lint / static", "Docs")).toBe("docs");
  expect(kindFor("lint / static", "Readme")).toBe("docs");
  expect(kindFor("types / compiler", "Typecheck")).toBe("types");
  expect(kindFor("types / compiler", "Install")).toBe("other");
  expect(kindFor("types / compiler", "Type cost")).toBe("types");
  expect(kindFor("package / checks", "Size")).toBe("size");
  expect(kindFor("test / migrate", "Test")).toBe("unit");
  expect(kindFor("test / migrate", undefined)).toBe("unit");
  expect(kindFor("suite", "Postgres suite")).toBe("postgres");
  expect(kindFor("tarball", undefined)).toBe("postgres");
  expect(kindFor("runtimes / portable", "Runtimes")).toBe("other");
});

test("the gate is not a reason when another job failed", () => {
  expect(
    kindsOf([
      { name: "test / schema", conclusion: "failure", failedSteps: ["Test"] },
      { name: "gate / check", conclusion: "failure", failedSteps: ["Require the slices"] },
      { name: "lint / static", conclusion: "success", failedSteps: [] },
    ]),
  ).toEqual(["unit"]);
  expect(
    kindsOf([{ name: "lint / static", conclusion: "failure", failedSteps: ["Format", "Docs"] }]),
  ).toEqual(["format/lint", "docs"]);
});

test("a re-run that passes is not a push-and-fail round, and a cancel is not either", () => {
  const attempts: readonly AttemptSnapshot[] = [
    attempt("aaa", "CI", 1, "failure", "2026-10-17T10:00:00Z", [
      { name: "test / client", conclusion: "failure", failedSteps: ["Test"] },
    ]),
    attempt("bbb", "CI", 1, "failure", "2026-10-17T11:00:00Z", [
      { name: "package / checks", conclusion: "failure", failedSteps: ["Size"] },
    ]),
    attempt("bbb", "CI", 2, "success", "2026-10-17T11:30:00Z", []),
    attempt("ccc", "CI", 1, "cancelled", "2026-10-17T12:00:00Z", []),
    attempt("ddd", "CI", 1, "success", "2026-10-17T13:00:00Z", []),
  ];
  const rounds = pushRounds(attempts);
  expect(rounds.pushes).toBe(4);
  expect(rounds.reruns).toBe(1);
  expect(rounds.failures).toEqual([
    { sha: "aaa", createdAt: "2026-10-17T10:00:00Z", kinds: ["unit"], other: [] },
  ]);
});

test("pull-request lint alone is not a round, and a later success beats an earlier failure", () => {
  const lintOnly = attempt("eee", "CI", 1, "failure", "2026-10-17T10:00:00Z", [
    { name: "lint / pull request", conclusion: "failure", failedSteps: ["Lint pull request"] },
    { name: "gate / check", conclusion: "success", failedSteps: [] },
  ]);
  expect(pushRounds([lintOnly]).failures).toEqual([]);

  const older = attempt("fff", "CI", 1, "failure", "2026-10-17T10:00:00Z", [
    { name: "lint / static", conclusion: "failure", failedSteps: ["Release flow"] },
  ]);
  const newer = attempt("fff", "CI", 1, "success", "2026-10-17T11:00:00Z", []);
  expect(pushRounds([older, newer]).failures).toEqual([]);
  expect(pushRounds([newer, older]).failures).toEqual([]);

  const release = pushRounds([older]);
  expect(release.failures).toEqual([
    {
      sha: "fff",
      createdAt: "2026-10-17T10:00:00Z",
      kinds: ["other"],
      other: ["Release flow"],
    },
  ]);
});

test("parseRun and parseJobs keep skipped jobs and drop a run that is still going", () => {
  expect(
    parseRun({
      id: 9,
      name: "CI",
      run_attempt: 2,
      event: "pull_request",
      conclusion: "failure",
      created_at: "2026-10-18T10:00:00Z",
      updated_at: "2026-10-18T10:05:00Z",
      head_sha: "abc1234",
      html_url: "https://example.test/9",
    }),
  ).toMatchObject({ id: 9, attempt: 2, runStartedAt: "2026-10-18T10:00:00Z" });
  expect(parseRun({ id: 9, name: "CI", conclusion: null })).toBeUndefined();
  expect(
    parseJobs({
      jobs: [
        {
          name: "suite",
          conclusion: "skipped",
          started_at: "2026-10-18T10:00:00Z",
          completed_at: "2026-10-18T10:00:00Z",
          steps: [],
        },
      ],
    }),
  ).toEqual([
    {
      name: "suite",
      conclusion: "skipped",
      startedAt: "2026-10-18T10:00:00Z",
      completedAt: "2026-10-18T10:00:00Z",
      steps: [],
    },
  ]);
});

test("the baseline names the method and the train", () => {
  const input: BaselineInput = {
    measuredAt: "2026-10-18T12:00:00.000Z",
    repo: "omqkhafi/okmodel",
    mainRuns: [
      {
        run: RUN,
        jobs: [
          job("test / migrate", "10:25:47Z", "10:28:40Z"),
          job("gate / check", "10:28:45Z", "10:28:52Z"),
        ],
      },
    ],
    pulls: [
      {
        number: 346,
        title: "fix(bun-sql): isolate sessions",
        attempts: [
          attempt("aaa1111", "CI", 1, "failure", "2026-10-17T10:00:00Z", [
            { name: "lint / static", conclusion: "failure", failedSteps: ["Format"] },
          ]),
        ],
      },
    ],
  };
  const text = renderBaseline(input);
  expect(text).toContain("## Method");
  expect(text).toContain("gate / check");
  expect(text).toContain("#346");
  expect(text).toContain("`aaa1111` format/lint");
  expect(text).toContain("test / migrate");
});

function job(
  name: string,
  started: string,
  completed: string,
  conclusion = "success",
): {
  name: string;
  conclusion: string;
  startedAt: string;
  completedAt: string;
  steps: readonly [];
} {
  return {
    name,
    conclusion,
    startedAt: `2026-10-18T${started}`,
    completedAt: `2026-10-18T${completed}`,
    steps: [],
  };
}

function attempt(
  sha: string,
  workflow: string,
  attemptNumber: number,
  conclusion: string,
  createdAt: string,
  jobs: AttemptSnapshot["jobs"],
): AttemptSnapshot {
  return { sha, workflow, attempt: attemptNumber, conclusion, createdAt, jobs };
}
