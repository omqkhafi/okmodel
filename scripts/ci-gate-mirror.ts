/**
 * Repeats the last `gate / check` conclusion for this commit.
 *
 * Used when a CI event did no work (for example an unrelated `labeled`
 * event). A skipped `gate / check` job would report Success and clear a
 * real failure; this job runs instead and exits with the prior result.
 *
 *   bun ./scripts/ci-gate-mirror.ts
 *
 * Reads `GITHUB_REPOSITORY`, `HEAD_SHA`, and `RUN_ID` from the environment.
 */

/** One Actions job from `gh api …/actions/runs/{id}/jobs`. */
export type RunJob = {
  readonly name?: string;
  readonly conclusion?: string | null;
};

/** One workflow run from `gh api …/actions/runs`. */
export type WorkflowRun = {
  readonly id: number;
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
};

/**
 * Exit code that matches a check conclusion.
 *
 * @param conclusion - GitHub conclusion string
 * @returns 0 for success, 1 otherwise
 */
export function exitCodeForConclusion(conclusion: string | null | undefined): number {
  return conclusion === "success" ? 0 : 1;
}

/**
 * Picks the gate job conclusion from a jobs list.
 *
 * @param jobs - Jobs on one workflow run
 * @returns The `gate / check` conclusion, or undefined when missing
 */
export function gateConclusion(jobs: readonly RunJob[]): string | undefined {
  for (const job of jobs) {
    if (job.name === "gate / check" && job.conclusion != null && job.conclusion.length > 0) {
      return job.conclusion;
    }
  }
  return undefined;
}

/**
 * Newest completed CI run other than the current one.
 *
 * A cancelled run did not finish `gate / check`. Label events can cancel
 * each other, so the mirror keeps looking for a run that completed.
 *
 * @param runs - Runs for this commit, newest first
 * @param currentRunId - This workflow run
 * @returns The prior run, or undefined
 */
export function priorCompletedRun(
  runs: readonly WorkflowRun[],
  currentRunId: number,
): WorkflowRun | undefined {
  for (const run of runs) {
    if (run.id === currentRunId) continue;
    if (run.name !== "CI") continue;
    if (run.status !== "completed") continue;
    if (run.conclusion === "cancelled") continue;
    return run;
  }
  return undefined;
}

function ghJson<T>(path: string): T {
  const proc = Bun.spawnSync(["gh", "api", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString().trim() || "gh api failed");
  }
  return JSON.parse(proc.stdout.toString()) as T;
}

if (import.meta.main) {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.HEAD_SHA;
  const runIdRaw = process.env.RUN_ID;
  if (repo === undefined || repo.length === 0 || sha === undefined || sha.length === 0) {
    console.error("usage: HEAD_SHA and GITHUB_REPOSITORY must be set");
    process.exit(1);
  }
  const currentRunId = Number(runIdRaw);
  if (!Number.isFinite(currentRunId)) {
    console.error("usage: RUN_ID must be a number");
    process.exit(1);
  }
  try {
    const listed = ghJson<{ workflow_runs: WorkflowRun[] }>(
      `repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&event=pull_request&per_page=20`,
    );
    const prior = priorCompletedRun(listed.workflow_runs, currentRunId);
    if (prior === undefined) {
      console.error("gate-mirror: no prior completed CI run for this commit");
      process.exit(1);
    }
    const jobs = ghJson<{ jobs: RunJob[] }>(
      `repos/${repo}/actions/runs/${prior.id}/jobs?per_page=100`,
    );
    const conclusion = gateConclusion(jobs.jobs);
    if (conclusion === undefined) {
      console.error(`gate-mirror: run ${prior.id} has no gate / check conclusion`);
      process.exit(1);
    }
    console.log(`gate-mirror: run ${prior.id} gate / check was ${conclusion}`);
    process.exit(exitCodeForConclusion(conclusion));
  } catch (error: unknown) {
    console.error("[ci-gate-mirror]", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
