/**
 * Reports CI duration from GitHub Actions.
 *
 * The last 30 completed workflow runs on `main`, plus pull requests #346
 * through #356 (the 0.9.1 train). Job and step duration, queue time, the
 * critical path, re-runs, and why each of those pulls failed a push.
 *
 *   bun ./scripts/ci-report.ts
 *   bun ./scripts/ci-report.ts --out reports/ci-baseline.md
 *   bun ./scripts/ci-report.ts --run 39119208437
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { repoRoot } from "./root.js";

/** Pulls whose push-and-fail rounds the 0.9.1 train asks for. */
export const TRAIN_PULLS = [346, 347, 348, 349, 350, 351, 352, 353, 354, 355, 356] as const;

/** How many completed runs on `main` the report reads. */
export const MAIN_RUN_LIMIT = 30;

const CI_WORKFLOW = "CI";
const GATE_JOB = "gate / check";

/** Jobs that do not sit on the path `gate / check` waits for. */
const OFF_GATE = new Set([GATE_JOB, "label / paths", "lint / pull request", "attest / measure"]);

/**
 * Failures that do not fail the required status. Path labels and the
 * pull-request lint can go red while `gate / check` stays green.
 */
const NOT_A_ROUND = new Set(["label / paths", "lint / pull request"]);

/** Setup steps. A failure here is not a format, type, or test failure. */
const SETUP_STEPS = new Set([
  "Set up job",
  "Checkout",
  "Setup Bun",
  "Setup Node",
  "Install",
  "Post Setup Bun",
  "Post Setup Node",
  "Post Checkout",
  "Complete job",
]);

/** Why a push's CI failed. Order is the report order. */
export const FAIL_KINDS = [
  "format/lint",
  "types",
  "unit",
  "postgres",
  "size",
  "docs",
  "other",
] as const;

/** One reason a failed job maps to. */
export type FailKind = (typeof FAIL_KINDS)[number];

/** One workflow run, without its jobs. */
export type WorkflowRun = {
  /** GitHub run id. */
  readonly id: number;
  /** Workflow name (`CI`, `Site`, `Windows`, …). */
  readonly name: string;
  /** `run_attempt`. 1 is the first try. */
  readonly attempt: number;
  /** `pull_request`, `push`, or another event. */
  readonly event: string;
  /** `success`, `failure`, `cancelled`, or another conclusion. */
  readonly conclusion: string;
  /** When the run was created. */
  readonly createdAt: string;
  /** When a runner accepted the run. */
  readonly runStartedAt: string;
  /** When GitHub last updated the run. */
  readonly updatedAt: string;
  /** Head commit. */
  readonly headSha: string;
  /** HTML URL of the run. */
  readonly url: string;
};

/** One step inside a job. */
export type StepTiming = {
  /** Step name. */
  readonly name: string;
  /** Step conclusion. Empty when GitHub sent none. */
  readonly conclusion: string;
  /** ISO start, or null when the step did not run. */
  readonly startedAt: string | null;
  /** ISO end, or null when the step did not run. */
  readonly completedAt: string | null;
};

/** One job inside a run. */
export type JobTiming = {
  /** Job name (`test / migrate`, `gate / check`, …). */
  readonly name: string;
  /** Job conclusion. */
  readonly conclusion: string;
  /** ISO start, or null when the job was skipped. */
  readonly startedAt: string | null;
  /** ISO end, or null when the job was skipped. */
  readonly completedAt: string | null;
  /** Steps, in GitHub's order. */
  readonly steps: readonly StepTiming[];
};

/** A run plus the jobs the report measured. */
export type MeasuredRun = {
  /** The workflow run. */
  readonly run: WorkflowRun;
  /** Its jobs. */
  readonly jobs: readonly JobTiming[];
};

/** A job that failed, reduced to what the classifier needs. */
export type FailedJob = {
  /** Job name. */
  readonly name: string;
  /** Job conclusion. */
  readonly conclusion: string;
  /** Names of steps whose conclusion is `failure`. */
  readonly failedSteps: readonly string[];
};

/** One workflow attempt on a pull-request commit. */
export type AttemptSnapshot = {
  /** Head SHA GitHub ran. */
  readonly sha: string;
  /** Workflow name. */
  readonly workflow: string;
  /** `run_attempt`. */
  readonly attempt: number;
  /** Latest conclusion for this run id. */
  readonly conclusion: string;
  /** When the run was created, used to order rounds. */
  readonly createdAt: string;
  /** Failed jobs. Empty when this attempt did not fail. */
  readonly jobs: readonly FailedJob[];
};

/** One pull in the train. */
export type PullMeasurement = {
  /** Pull number. */
  readonly number: number;
  /** Pull title. */
  readonly title: string;
  /** Workflow attempts whose head SHA is a commit on the pull. */
  readonly attempts: readonly AttemptSnapshot[];
};

/** Everything `renderBaseline` prints. */
export type BaselineInput = {
  /** ISO time the sample was read. */
  readonly measuredAt: string;
  /** `owner/name`. */
  readonly repo: string;
  /** The newest completed runs on `main`, newest first. */
  readonly mainRuns: readonly MeasuredRun[];
  /** Train pulls, in {@link TRAIN_PULLS} order. */
  readonly pulls: readonly PullMeasurement[];
};

/** Queue, walls, and the job the gate waited on. */
export type CriticalPath = {
  /** `run_started_at − created_at`, seconds. */
  readonly queueSeconds: number;
  /** Time until `gate / check` completed, or until the run updated. */
  readonly gateWallSeconds: number;
  /** `updated_at − created_at`, seconds. */
  readonly runWallSeconds: number;
  /** Duration of `gate / check`, or 0 when that job did not run. */
  readonly gateSeconds: number;
  /** Job the gate waited on, or the job that finished last. */
  readonly longPole: string;
  /** That job's own duration, seconds. */
  readonly longPoleSeconds: number;
};

/**
 * Whole seconds from `start` to `end`.
 *
 * @param start - ISO timestamp
 * @param end - ISO timestamp
 * @returns Seconds, or undefined when a timestamp does not parse or `end` is earlier
 */
export function elapsedSeconds(start: string, end: string): number | undefined {
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return undefined;
  return Math.round((to - from) / 1000);
}

/**
 * Median, rounding the mean of the two middle values when the count is even.
 *
 * @param values - Samples. The array is not modified
 * @returns The median, or undefined when `values` is empty
 */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return undefined;
  if (values.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  if (lower === undefined) return undefined;
  return Math.round((lower + upper) / 2);
}

/**
 * Nearest-rank percentile.
 *
 * @param values - Samples. The array is not modified
 * @param p - Percent from 0 to 100
 * @returns The value at that rank, or undefined when `values` is empty
 */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/**
 * Maps a failed job, and the step that failed, onto a reason.
 *
 * A named check step wins over the job name. Setup steps stay `other`.
 * A job with no failed step uses the job name.
 *
 * @param jobName - Job name
 * @param stepName - Failed step, or undefined when no step was marked failed
 * @returns The reason
 */
export function kindFor(jobName: string, stepName: string | undefined): FailKind {
  if (stepName !== undefined && SETUP_STEPS.has(stepName)) return "other";
  switch (stepName) {
    case "Format":
    case "Lint":
      return "format/lint";
    case "Typecheck":
    case "Editor":
    case "Type cost":
      return "types";
    case "Docs":
    case "Readme":
      return "docs";
    case "Size":
      return "size";
    case "Postgres suite":
    case "Tarball quickstart":
      return "postgres";
    case "Test":
      return "unit";
    default:
      break;
  }
  if (
    jobName === "suite" ||
    jobName === "tarball" ||
    jobName.startsWith("suite /") ||
    jobName.startsWith("tarball /")
  ) {
    return "postgres";
  }
  if (jobName.startsWith("test /")) return "unit";
  if (jobName === "types / compiler") return "types";
  return "other";
}

/**
 * Reasons for one failed attempt.
 *
 * `gate / check` is ignored when another job failed: the gate only repeats that
 * failure. `label / paths` and `lint / pull request` are ignored entirely,
 * because the required status does not wait on them. An attempt whose only
 * failures are those jobs has no reasons.
 *
 * @param jobs - Jobs from the attempt
 * @returns Reasons, in {@link FAIL_KINDS} order, without duplicates
 */
export function kindsOf(jobs: readonly FailedJob[]): readonly FailKind[] {
  const failed = jobs.filter((job) => job.conclusion === "failure" && !NOT_A_ROUND.has(job.name));
  const specific = failed.filter((job) => job.name !== GATE_JOB);
  const source = specific.length > 0 ? specific : failed;
  const found = new Set<FailKind>();
  for (const job of source) {
    if (job.failedSteps.length === 0) {
      found.add(kindFor(job.name, undefined));
      continue;
    }
    for (const step of job.failedSteps) found.add(kindFor(job.name, step));
  }
  return FAIL_KINDS.filter((kind) => found.has(kind));
}

/**
 * Failed step names (or the job name, when no step was marked) that landed in
 * `other`.
 *
 * @param jobs - Jobs from the attempt
 * @returns Names, in first-seen order, without duplicates
 */
export function otherDetail(jobs: readonly FailedJob[]): readonly string[] {
  const failed = jobs.filter((job) => job.conclusion === "failure" && !NOT_A_ROUND.has(job.name));
  const specific = failed.filter((job) => job.name !== GATE_JOB);
  const source = specific.length > 0 ? specific : failed;
  const names: string[] = [];
  for (const job of source) {
    const steps = job.failedSteps.length > 0 ? job.failedSteps : [undefined];
    for (const step of steps) {
      if (kindFor(job.name, step) !== "other") continue;
      const name = step ?? job.name;
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * Critical path of one run.
 *
 * Queue is `run_started_at − created_at`. For a CI run that reached
 * `gate / check`, the gate wall is how long the required status took, and the
 * long pole is the other job with the latest `completed_at` at or before the
 * gate started. Attest, path labels, and the pull-request lint do not block
 * the gate. A run with no timed job has no path.
 *
 * @param run - Workflow run
 * @param jobs - Its jobs
 * @returns The path, or undefined when nothing ran
 */
export function criticalPath(
  run: WorkflowRun,
  jobs: readonly JobTiming[],
): CriticalPath | undefined {
  const timed = jobs.filter(
    (job): job is JobTiming & { startedAt: string; completedAt: string } =>
      job.conclusion !== "skipped" && job.startedAt !== null && job.completedAt !== null,
  );
  if (timed.length === 0) return undefined;
  const queue = elapsedSeconds(run.createdAt, run.runStartedAt) ?? 0;
  const runWall = elapsedSeconds(run.createdAt, run.updatedAt) ?? 0;
  const gate = timed.find((job) => job.name === GATE_JOB);
  const gateWall = gate ? (elapsedSeconds(run.createdAt, gate.completedAt) ?? runWall) : runWall;
  const gateSeconds = gate ? (elapsedSeconds(gate.startedAt, gate.completedAt) ?? 0) : 0;
  const gateStart = gate ? Date.parse(gate.startedAt) : Number.POSITIVE_INFINITY;
  const pool = timed.filter((job) => (gate ? !OFF_GATE.has(job.name) : true));
  const beforeGate = pool.filter((job) => Date.parse(job.completedAt) <= gateStart + 1000);
  const candidates = beforeGate.length > 0 ? beforeGate : pool;
  const longPole = candidates.reduce((best, job) =>
    Date.parse(job.completedAt) > Date.parse(best.completedAt) ? job : best,
  );
  return {
    queueSeconds: queue,
    gateWallSeconds: gateWall,
    runWallSeconds: runWall,
    gateSeconds,
    longPole: longPole.name,
    longPoleSeconds: elapsedSeconds(longPole.startedAt, longPole.completedAt) ?? 0,
  };
}

/** One push whose latest attempt of some workflow failed the required status. */
export type FailRound = {
  /** Head SHA. */
  readonly sha: string;
  /** When the earliest failing attempt on that SHA was created. */
  readonly createdAt: string;
  /** Union of reasons across the workflows that failed. */
  readonly kinds: readonly FailKind[];
  /** Step or job names that were classified `other`. */
  readonly other: readonly string[];
};

/** Pushes and the ones whose latest attempt failed. */
export type PushRounds = {
  /** Commits that received a workflow run. */
  readonly pushes: number;
  /** Attempts with `run_attempt > 1`. */
  readonly reruns: number;
  /** Pushes that still concluded `failure`. */
  readonly failures: readonly FailRound[];
};

/**
 * Counts pushes, re-runs, and push-and-fail rounds.
 *
 * A push is one head SHA. The latest attempt of each workflow on that SHA is
 * what counts: a later `createdAt` wins when `run_attempt` is tied, a re-run
 * that then succeeded is not a failed round, and a `cancelled` run (a newer
 * push superseded it) is not either. A red `lint / pull request` or
 * `label / paths` job is not a round when nothing the gate waits on failed.
 *
 * @param attempts - Every attempt returned for the pull
 * @returns The rounds
 */
export function pushRounds(attempts: readonly AttemptSnapshot[]): PushRounds {
  const latest = new Map<string, AttemptSnapshot>();
  for (const attempt of attempts) {
    const key = `${attempt.sha}\0${attempt.workflow}`;
    const previous = latest.get(key);
    if (previous === undefined || preferAttempt(attempt, previous)) latest.set(key, attempt);
  }
  const shas = new Set(attempts.map((attempt) => attempt.sha));
  const failures: FailRound[] = [];
  for (const sha of shas) {
    const failed = [...latest.values()].filter(
      (attempt) => attempt.sha === sha && attempt.conclusion === "failure",
    );
    const found = new Set<FailKind>();
    const other: string[] = [];
    for (const attempt of failed) {
      for (const kind of kindsOf(attempt.jobs)) found.add(kind);
      for (const name of otherDetail(attempt.jobs)) {
        if (!other.includes(name)) other.push(name);
      }
    }
    const kinds = FAIL_KINDS.filter((kind) => found.has(kind));
    if (kinds.length === 0) continue;
    const createdAt = failed
      .map((attempt) => attempt.createdAt)
      .sort()
      .at(0);
    failures.push({ sha, createdAt: createdAt ?? "", kinds, other });
  }
  failures.sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1));
  return {
    pushes: shas.size,
    reruns: attempts.filter((attempt) => attempt.attempt > 1).length,
    failures,
  };
}

/**
 * Renders the baseline markdown.
 *
 * @param input - Measured runs and train pulls
 * @returns The document
 */
export function renderBaseline(input: BaselineInput): string {
  const ci = input.mainRuns.filter((measured) => measured.run.name === CI_WORKFLOW);
  const lines: string[] = [
    "# CI baseline",
    "",
    `Before number for the CI diet (issue #359). Produced by \`bun run ci:report\` at ${input.measuredAt} from \`${input.repo}\`. Do not edit the tables by hand; run the command again.`,
    "",
    "## Method",
    "",
    ...METHOD,
    "",
    "## Main sample",
    "",
    `${String(input.mainRuns.length)} completed runs on \`main\`, newest first. ${String(ci.length)} of them are the CI workflow.`,
    "",
    workflowTable(input.mainRuns),
    "",
    runTable(input.mainRuns),
    "",
    "## Critical path",
    "",
    ...criticalSection(ci),
    "",
    "## Re-runs",
    "",
    rerunSection(input.mainRuns),
    "",
    "## CI jobs",
    "",
    durationTable(jobDurations(ci), "Job"),
    "",
    "## CI steps",
    "",
    stepSection(ci),
    "",
    "## 0.9.1 train",
    "",
    "Pulls #346 through #356. A push is a commit SHA that received a workflow run. A fail round is a push whose latest attempt failed a job the required status waits on. A red pull-request lint alone is not a round.",
    "",
    pullTable(input.repo, input.pulls),
    "",
  ];
  return lines.join("\n");
}

const METHOD = [
  "`ci:report` shells out to `gh api` for the repository `gh repo view` names.",
  "",
  "- **Main sample.** `GET /repos/{owner}/{repo}/actions/runs?branch=main&status=completed&per_page=30`, the thirty newest completed runs on `main`, every workflow.",
  "- **Jobs and steps.** `GET /repos/{owner}/{repo}/actions/runs/{id}/jobs?per_page=100` for each of those runs. Duration is `completed_at` minus `started_at`, in whole seconds. A skipped job, or a step with no timestamps, is left out of the duration tables.",
  "- **Queue.** `run_started_at` minus `created_at` for the workflow run. That is time spent before a runner accepted the run.",
  "- **Gate wall.** For a CI run, `gate / check`'s `completed_at` minus `created_at`. That is how long the required status takes. **Run wall** is `updated_at` minus `created_at`, which stays open while jobs the gate does not need are still running.",
  "- **Critical path.** The long pole is the job the gate waited on: among jobs other than `gate / check`, `label / paths`, `lint / pull request`, and `attest / measure`, the one with the latest `completed_at` at or before the gate started. The path is that job, then the gate. A workflow with no gate uses the job that finished last, and its gate wall is the run wall.",
  "- **Re-runs.** A run with `run_attempt` greater than 1. Extra attempts are `run_attempt` minus 1.",
  "- **Train pulls.** For each of #346 through #356, the pull, its commits (`per_page=100`), then `GET /repos/{owner}/{repo}/actions/runs?head_sha={sha}&per_page=50` for each commit. Only `pull_request` runs are kept. A commit that was never a head SHA has no run and is not a push.",
  "- **Why.** A push-and-fail round is a push whose latest attempt failed a job `gate / check` waits on. `lint / pull request` and `label / paths` do not count: the required status does not wait on them, so a red pull-request lint alone is not a round. `gate / check` itself is ignored when another job failed, because it only repeats that failure. A named step wins. Format or Lint is format/lint. Typecheck, Editor, or Type cost is types. Docs or Readme is docs. Size is the size gate. Test, or a `test / …` job with no failed step, is unit. A job named `suite` or `tarball` (including `suite / 18 / consistency`), or a Postgres suite or Tarball quickstart step, is Postgres. Setup steps and anything else are other, and the step name is kept in the table. A `lint / static` failure on Layers, or a `types / compiler` failure on Install, stays other.",
  "- **Median.** The middle value. An even count rounds the mean of the two middle values to the nearest second (half rounds away from zero). **p90** is the nearest-rank percentile.",
];

function preferAttempt(next: AttemptSnapshot, previous: AttemptSnapshot): boolean {
  if (next.attempt !== previous.attempt) return next.attempt > previous.attempt;
  return next.createdAt > previous.createdAt;
}

function workflowTable(runs: readonly MeasuredRun[]): string {
  const byName = new Map<string, MeasuredRun[]>();
  for (const measured of runs) {
    const list = byName.get(measured.run.name) ?? [];
    list.push(measured);
    byName.set(measured.run.name, list);
  }
  const lines = [
    "| Workflow | Runs | Median run wall | Median queue | Re-runs |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const [name, list] of [...byName.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    const walls = list.map(
      (measured) => elapsedSeconds(measured.run.createdAt, measured.run.updatedAt) ?? 0,
    );
    const queues = list.map(
      (measured) => elapsedSeconds(measured.run.createdAt, measured.run.runStartedAt) ?? 0,
    );
    lines.push(
      `| ${name} | ${String(list.length)} | ${seconds(median(walls))} | ${seconds(median(queues))} | ${String(list.filter((measured) => measured.run.attempt > 1).length)} |`,
    );
  }
  return lines.join("\n");
}

function runTable(runs: readonly MeasuredRun[]): string {
  const lines = [
    "| Run | Workflow | Queue | Gate wall | Run wall | Long pole | Attempt |",
    "| --- | --- | ---: | ---: | ---: | --- | ---: |",
  ];
  for (const measured of runs) {
    const path = criticalPath(measured.run, measured.jobs);
    const runWall = elapsedSeconds(measured.run.createdAt, measured.run.updatedAt) ?? 0;
    lines.push(
      `| [${String(measured.run.id)}](${measured.run.url}) | ${measured.run.name} | ${seconds(path?.queueSeconds ?? 0)} | ${path ? seconds(path.gateWallSeconds) : "—"} | ${seconds(runWall)} | ${path ? `${path.longPole} (${seconds(path.longPoleSeconds)})` : "—"} | ${String(measured.run.attempt)} |`,
    );
  }
  return lines.join("\n");
}

function criticalSection(ci: readonly MeasuredRun[]): readonly string[] {
  const paths = ci.flatMap((measured) => {
    const path = criticalPath(measured.run, measured.jobs);
    return path ? [path] : [];
  });
  if (paths.length === 0) return ["No CI run in the sample had a timed job."];
  const walls = paths.map((path) => path.gateWallSeconds);
  const queues = paths.map((path) => path.queueSeconds);
  const counts = new Map<string, number>();
  for (const path of paths) counts.set(path.longPole, (counts.get(path.longPole) ?? 0) + 1);
  const poles = [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  const poleText = poles.map(([name, count]) => `${name} (${String(count)})`).join(", ");
  return [
    `CI runs in the sample: ${String(paths.length)}.`,
    "",
    `| | Median | p90 | Min | Max |`,
    `| --- | ---: | ---: | ---: | ---: |`,
    `| Gate wall | ${seconds(median(walls))} | ${seconds(percentile(walls, 90))} | ${seconds(Math.min(...walls))} | ${seconds(Math.max(...walls))} |`,
    `| Queue | ${seconds(median(queues))} | ${seconds(percentile(queues, 90))} | ${seconds(Math.min(...queues))} | ${seconds(Math.max(...queues))} |`,
    "",
    `Long pole, by how often it was the job the gate waited on: ${poleText}.`,
  ];
}

function rerunSection(runs: readonly MeasuredRun[]): string {
  const extras = runs.filter((measured) => measured.run.attempt > 1);
  if (extras.length === 0) return "None of the 30 runs was a re-run (`run_attempt` is 1 on each).";
  const extraAttempts = extras.reduce((sum, measured) => sum + (measured.run.attempt - 1), 0);
  const lines = [
    `${String(extras.length)} runs had \`run_attempt\` greater than 1 (${String(extraAttempts)} extra attempts).`,
    "",
  ];
  for (const measured of extras) {
    lines.push(
      `- [${measured.run.name} ${String(measured.run.id)}](${measured.run.url}) attempt ${String(measured.run.attempt)}, ${measured.run.conclusion}`,
    );
  }
  return lines.join("\n");
}

function jobDurations(runs: readonly MeasuredRun[]): readonly DurationRow[] {
  const byName = new Map<string, number[]>();
  for (const measured of runs) {
    for (const job of measured.jobs) {
      if (job.conclusion === "skipped" || job.startedAt === null || job.completedAt === null)
        continue;
      const duration = elapsedSeconds(job.startedAt, job.completedAt);
      if (duration === undefined) continue;
      const list = byName.get(job.name) ?? [];
      list.push(duration);
      byName.set(job.name, list);
    }
  }
  return rowsFrom(byName);
}

function stepSection(ci: readonly MeasuredRun[]): string {
  const byName = new Map<string, number[]>();
  for (const measured of ci) {
    for (const job of measured.jobs) {
      if (job.conclusion === "skipped") continue;
      for (const step of job.steps) {
        if (step.startedAt === null || step.completedAt === null) continue;
        const duration = elapsedSeconds(step.startedAt, step.completedAt);
        if (duration === undefined) continue;
        const key = `${job.name} / ${step.name}`;
        const list = byName.get(key) ?? [];
        list.push(duration);
        byName.set(key, list);
      }
    }
  }
  const rows = rowsFrom(byName);
  const slow = rows.filter((row) => (median(row.samples) ?? 0) >= 2);
  const fast = rows.length - slow.length;
  return [
    durationTable(slow, "Step"),
    "",
    `${String(fast)} steps had a median under 2s and are omitted (checkout, setup, and the other short steps). ${String(rows.length)} steps were measured.`,
  ].join("\n");
}

type DurationRow = {
  readonly name: string;
  readonly samples: readonly number[];
};

function rowsFrom(byName: ReadonlyMap<string, number[]>): readonly DurationRow[] {
  return [...byName.entries()]
    .map(([name, samples]) => ({ name, samples }))
    .sort((left, right) => {
      const delta = (median(right.samples) ?? 0) - (median(left.samples) ?? 0);
      return delta !== 0 ? delta : left.name.localeCompare(right.name);
    });
}

function durationTable(rows: readonly DurationRow[], label: string): string {
  if (rows.length === 0) return `No ${label.toLowerCase()} durations.`;
  const lines = [`| ${label} | N | Median | p90 | Max |`, "| --- | ---: | ---: | ---: | ---: |"];
  for (const row of rows) {
    lines.push(
      `| ${row.name} | ${String(row.samples.length)} | ${seconds(median(row.samples))} | ${seconds(percentile(row.samples, 90))} | ${seconds(Math.max(...row.samples))} |`,
    );
  }
  return lines.join("\n");
}

function pullTable(repo: string, pulls: readonly PullMeasurement[]): string {
  const lines = [
    "| Pull | Pushes | Fail rounds | Re-runs | Why |",
    "| --- | ---: | ---: | ---: | --- |",
  ];
  for (const pull of pulls) {
    const rounds = pushRounds(pull.attempts);
    const why =
      rounds.failures.length === 0
        ? "—"
        : rounds.failures
            .map((failure) => `\`${failure.sha.slice(0, 7)}\` ${formatKinds(failure)}`)
            .join("; ");
    lines.push(
      `| [#${String(pull.number)} ${escapeCell(pull.title)}](https://github.com/${repo}/pull/${String(pull.number)}) | ${String(rounds.pushes)} | ${String(rounds.failures.length)} | ${String(rounds.reruns)} | ${why} |`,
    );
  }
  return lines.join("\n");
}

function formatKinds(failure: FailRound): string {
  const kinds = failure.kinds.filter((kind) => kind !== "other");
  const other = failure.kinds.includes("other")
    ? `other${failure.other.length > 0 ? ` (${failure.other.join(", ")})` : ""}`
    : "";
  return [...kinds, other].filter((part) => part.length > 0).join(", ");
}

function seconds(value: number | undefined): string {
  return value === undefined ? "—" : `${String(value)}s`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Parses one workflow run object from the Actions API.
 *
 * @param value - One element of `workflow_runs`
 * @returns The run, or undefined when a required field is missing or the run is not completed
 */
export function parseRun(value: unknown): WorkflowRun | undefined {
  if (!isRecord(value)) return undefined;
  const id = num(value.id);
  const name = str(value.name);
  const attempt = num(value.run_attempt);
  const event = str(value.event);
  const conclusion = str(value.conclusion);
  const createdAt = str(value.created_at);
  const updatedAt = str(value.updated_at);
  const headSha = str(value.head_sha);
  const url = str(value.html_url);
  if (
    id === undefined ||
    name === undefined ||
    attempt === undefined ||
    event === undefined ||
    conclusion === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    headSha === undefined ||
    url === undefined
  ) {
    return undefined;
  }
  return {
    id,
    name,
    attempt,
    event,
    conclusion,
    createdAt,
    runStartedAt: str(value.run_started_at) ?? createdAt,
    updatedAt,
    headSha,
    url,
  };
}

/**
 * Parses the jobs payload.
 *
 * @param value - The jobs API object
 * @returns Jobs, skipping entries that have no name
 */
export function parseJobs(value: unknown): readonly JobTiming[] {
  if (!isRecord(value) || !Array.isArray(value.jobs)) return [];
  const jobs: JobTiming[] = [];
  for (const item of value.jobs) {
    const job = parseJob(item);
    if (job !== undefined) jobs.push(job);
  }
  return jobs;
}

function parseJob(value: unknown): JobTiming | undefined {
  if (!isRecord(value)) return undefined;
  const name = str(value.name);
  if (name === undefined) return undefined;
  const steps: StepTiming[] = [];
  if (Array.isArray(value.steps)) {
    for (const step of value.steps) {
      if (!isRecord(step)) continue;
      const stepName = str(step.name);
      if (stepName === undefined) continue;
      steps.push({
        name: stepName,
        conclusion: str(step.conclusion) ?? "",
        startedAt: str(step.started_at) ?? null,
        completedAt: str(step.completed_at) ?? null,
      });
    }
  }
  return {
    name,
    conclusion: str(value.conclusion) ?? "",
    startedAt: str(value.started_at) ?? null,
    completedAt: str(value.completed_at) ?? null,
    steps,
  };
}

function ghApi(apiPath: string): unknown {
  const proc = Bun.spawnSync(["gh", "api", apiPath], {
    cwd: repoRoot(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`gh api ${apiPath}\n${proc.stderr.toString().trim()}`);
  }
  return JSON.parse(proc.stdout.toString()) as unknown;
}

function repoSlug(): string {
  const proc = Bun.spawnSync(
    ["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    {
      cwd: repoRoot(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`gh repo view failed\n${proc.stderr.toString().trim()}`);
  }
  const slug = proc.stdout.toString().trim();
  if (slug.length === 0) throw new Error("gh repo view returned an empty name");
  return slug;
}

function runItems(apiPath: string): readonly unknown[] {
  const payload = ghApi(apiPath);
  if (!isRecord(payload) || !Array.isArray(payload.workflow_runs)) return [];
  return payload.workflow_runs;
}

function loadJobs(repo: string, runId: number): readonly JobTiming[] {
  const jobs: JobTiming[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const payload = ghApi(
      `repos/${repo}/actions/runs/${String(runId)}/jobs?per_page=100&page=${String(page)}`,
    );
    const batch = parseJobs(payload);
    jobs.push(...batch);
    const total = isRecord(payload) ? num(payload.total_count) : undefined;
    if (batch.length < 100 || (total !== undefined && jobs.length >= total)) break;
  }
  return jobs;
}

function loadMain(repo: string): readonly MeasuredRun[] {
  const items = runItems(
    `repos/${repo}/actions/runs?branch=main&status=completed&per_page=${String(MAIN_RUN_LIMIT)}`,
  ).slice(0, MAIN_RUN_LIMIT);
  const measured: MeasuredRun[] = [];
  for (const item of items) {
    const run = parseRun(item);
    if (run === undefined) continue;
    console.error(`[ci:report] ${run.name} ${String(run.id)}`);
    measured.push({ run, jobs: loadJobs(repo, run.id) });
  }
  return measured;
}

function loadPull(repo: string, number: number): PullMeasurement {
  const payload = ghApi(`repos/${repo}/pulls/${String(number)}`);
  const title = isRecord(payload) ? (str(payload.title) ?? "") : "";
  const commits = ghApi(`repos/${repo}/pulls/${String(number)}/commits?per_page=100`);
  const shas: string[] = [];
  if (Array.isArray(commits)) {
    for (const commit of commits) {
      if (!isRecord(commit)) continue;
      const sha = str(commit.sha);
      if (sha !== undefined) shas.push(sha);
    }
  }
  console.error(`[ci:report] #${String(number)} ${String(shas.length)} commits`);
  const attempts: AttemptSnapshot[] = [];
  for (const sha of shas) {
    const runs = runItems(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`);
    for (const item of runs) {
      const run = parseRun(item);
      if (run === undefined || run.event !== "pull_request") continue;
      const jobs =
        run.conclusion === "failure"
          ? loadJobs(repo, run.id).map((job) => ({
              name: job.name,
              conclusion: job.conclusion,
              failedSteps: job.steps
                .filter((step) => step.conclusion === "failure")
                .map((step) => step.name),
            }))
          : [];
      attempts.push({
        sha: run.headSha,
        workflow: run.name,
        attempt: run.attempt,
        conclusion: run.conclusion,
        createdAt: run.createdAt,
        jobs,
      });
    }
  }
  return { number, title, attempts };
}

function singleRunReport(repo: string, runId: number): string {
  const payload = ghApi(`repos/${repo}/actions/runs/${String(runId)}`);
  const run = parseRun(payload);
  if (run === undefined) throw new Error(`run ${String(runId)} did not parse`);
  const jobs = loadJobs(repo, runId);
  const path = criticalPath(run, jobs);
  const lines = [
    `# Run ${String(run.id)}`,
    "",
    `${run.name} ${run.conclusion}, attempt ${String(run.attempt)}.`,
    "",
  ];
  if (path) {
    lines.push(
      `Queue ${seconds(path.queueSeconds)}. Gate wall ${seconds(path.gateWallSeconds)}. Run wall ${seconds(path.runWallSeconds)}.`,
      `Long pole: ${path.longPole} (${seconds(path.longPoleSeconds)}), then gate ${seconds(path.gateSeconds)}.`,
      "",
    );
  }
  lines.push(durationTable(jobDurations([{ run, jobs }]), "Job"), "");
  return lines.join("\n");
}

function main(): void {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      run: { type: "string" },
    },
    args: process.argv.slice(2),
    strict: true,
  });
  const repo = repoSlug();
  if (values.run !== undefined) {
    const runId = Number(values.run);
    if (!Number.isInteger(runId) || runId < 1) {
      throw new Error("usage: bun ./scripts/ci-report.ts --run <id>");
    }
    const text = singleRunReport(repo, runId);
    if (values.out !== undefined) writeFileSync(values.out, text);
    else process.stdout.write(text);
    return;
  }
  const input: BaselineInput = {
    measuredAt: new Date().toISOString(),
    repo,
    mainRuns: loadMain(repo),
    pulls: TRAIN_PULLS.map((number) => loadPull(repo, number)),
  };
  const text = renderBaseline(input);
  if (values.out !== undefined) writeFileSync(values.out, text);
  else process.stdout.write(text);
}

if (import.meta.main) {
  try {
    main();
  } catch (error: unknown) {
    console.error("[ci:report]", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
