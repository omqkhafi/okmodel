/**
 * Prints the first failing job on a pull request.
 *
 * The job, the step, the last 60 log lines of that step, and the one local
 * command that reproduces it.
 *
 *   bun ./scripts/ci-fail.ts 371
 */

import { parseArgs } from "node:util";

import { ciTestGroups } from "./ci-test-groups.js";
import { repoRoot } from "./root.js";

const LOG_LINES = 60;

const STEP_COMMANDS: Readonly<Record<string, string>> = {
  Format: "bun run format:check",
  Lint: "bun run lint",
  Layers: "bun run layers-check",
  "Core purity": "bun run core-purity",
  "OKID drift": "bun run okid-drift",
  Docs: "bun run docs:check",
  Readme: "bun run readme:check",
  "Compiler API": "bun run compiler-api",
  "Bundle purity": "bun run bundle-purity",
  "Release flow": "bun ./scripts/release-check.ts --base origin/main",
  Typecheck: "bun run typecheck",
  Editor: "bun run editor-check",
  "Type cost": "bun run type-cost",
  Runtimes: "bun run test:runtimes",
  Publint: "bun run publint",
  "Are the types wrong": "bun run attw",
  "Packed files are tracked": "bun run pack-tracked",
  Size: "bun run size",
  Build: "bun run build",
  Attest: "bun run attest",
  Install: "bun install --frozen-lockfile",
  "Date/time columns":
    "bun build scripts/node-temporal.ts --target node --external temporal-polyfill --outfile ./node_modules/.cache/okm-temporal.mjs && node ./node_modules/.cache/okm-temporal.mjs",
  "Tarball quickstart": "REQUIRE_DOCKER=1 bun run test:tarball",
  "Require the slices": "# gate / check repeats a slice above; fix that slice",
};

/**
 * The local command that reruns one failed step.
 *
 * @param jobName - Job name from the Actions API (`test / migrate`, `suite / 18 / tx`)
 * @param stepName - The step whose conclusion is `failure`
 * @param root - Repository root, used to expand a test group
 * @returns One command, without a shell wrapper except where the step itself is a chain
 */
export function reproduceCommand(jobName: string, stepName: string, root: string): string {
  if (stepName === "Test" && jobName.startsWith("test / ")) {
    const group = jobName.slice("test / ".length);
    const files = ciTestGroups(root).find((item) => item.name === group)?.files;
    if (files !== undefined && files.length > 0) return `bun test ${files.join(" ")}`;
  }
  if (stepName === "Postgres suite" || jobName.startsWith("suite / ")) {
    const parts = jobName.split(" / ");
    const version = parts[1];
    const shard = parts[2];
    if (version !== undefined && shard !== undefined) {
      return `REQUIRE_DOCKER=1 POSTGRES_VERSION=${version} bun ./scripts/postgres-suite.ts --shard ${shard}`;
    }
  }
  return STEP_COMMANDS[stepName] ?? `# no local command for ${jobName} / ${stepName}`;
}

/**
 * Last lines of the log group for one step.
 *
 * GitHub prefixes each line with a timestamp and opens a step with
 * `##[group]<name>`. When the step name never appears, the tail is the whole
 * log.
 *
 * @param log - Job log text
 * @param stepName - Step to keep
 * @param limit - How many lines to keep. Defaults to 60
 * @returns Those lines, joined with newlines
 */
export function tailStep(log: string, stepName: string, limit = LOG_LINES): string {
  const lines = log.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !line.includes("##[group]") || !line.includes(stepName)) continue;
    start = index + 1;
    end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      const later = lines[next];
      if (later !== undefined && (later.includes("##[endgroup]") || later.includes("##[group]"))) {
        end = next;
        break;
      }
    }
  }
  const slice = start === -1 ? lines : lines.slice(start, end);
  return slice.slice(-limit).join("\n");
}

type FailedStep = {
  readonly job: string;
  readonly step: string;
  readonly jobId: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function ghText(apiPath: string): string {
  const proc = Bun.spawnSync(["gh", "api", apiPath], {
    cwd: repoRoot(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`gh api ${apiPath}\n${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString();
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
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString().trim() || "gh repo view failed");
  const slug = proc.stdout.toString().trim();
  if (slug.length === 0) throw new Error("gh repo view returned an empty name");
  return slug;
}

function firstFailure(repo: string, pull: number): FailedStep {
  const payload = ghApi(`repos/${repo}/pulls/${String(pull)}`);
  if (!isRecord(payload) || !isRecord(payload.head)) {
    throw new Error(`pull ${String(pull)} has no head`);
  }
  const sha = str(payload.head.sha);
  if (sha === undefined) throw new Error(`pull ${String(pull)} has no head sha`);
  const runsPayload = ghApi(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`);
  if (!isRecord(runsPayload) || !Array.isArray(runsPayload.workflow_runs)) {
    throw new Error(`no workflow runs for ${sha}`);
  }
  const runs = runsPayload.workflow_runs.filter(
    (item) => isRecord(item) && item.name === "CI" && item.event === "pull_request",
  );
  const latest = runs.reduce<Record<string, unknown> | undefined>((best, item) => {
    if (!isRecord(item)) return best;
    if (best === undefined) return item;
    const created = str(item.created_at) ?? "";
    const previous = str(best.created_at) ?? "";
    return created > previous ? item : best;
  }, undefined);
  if (latest === undefined) throw new Error(`pull ${String(pull)} has no CI run`);
  const runId = num(latest.id);
  if (runId === undefined) throw new Error("CI run has no id");
  const jobsPayload = ghApi(`repos/${repo}/actions/runs/${String(runId)}/jobs?per_page=100`);
  if (!isRecord(jobsPayload) || !Array.isArray(jobsPayload.jobs)) {
    throw new Error(`CI run ${String(runId)} has no jobs`);
  }
  const failures = jobsPayload.jobs.filter(
    (item) => isRecord(item) && item.conclusion === "failure",
  );
  const specific = failures.filter((item) => isRecord(item) && item.name !== "gate / check");
  const failed = specific.length > 0 ? specific : failures;
  failed.sort((left, right) => {
    if (!isRecord(left) || !isRecord(right)) return 0;
    const a = str(left.completed_at) ?? "";
    const b = str(right.completed_at) ?? "";
    return a < b ? -1 : 1;
  });
  const job = failed[0];
  if (!isRecord(job)) throw new Error(`CI run ${String(runId)} has no failing job`);
  const jobName = str(job.name);
  const jobId = num(job.id);
  if (jobName === undefined || jobId === undefined) throw new Error("failing job has no name");
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const step = steps.find((item) => isRecord(item) && item.conclusion === "failure");
  const stepName = isRecord(step) ? (str(step.name) ?? jobName) : jobName;
  return { job: jobName, step: stepName, jobId };
}

function main(): void {
  const { positionals } = parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2),
    strict: true,
  });
  const pull = Number(positionals[0]);
  if (!Number.isInteger(pull) || pull < 1) {
    console.error("usage: bun ./scripts/ci-fail.ts <pull>");
    process.exit(1);
  }
  const repo = repoSlug();
  const failed = firstFailure(repo, pull);
  const log = ghText(`repos/${repo}/actions/jobs/${String(failed.jobId)}/logs`);
  const command = reproduceCommand(failed.job, failed.step, repoRoot());
  process.stdout.write(
    `job: ${failed.job}\nstep: ${failed.step}\nreproduce: ${command}\n\n${tailStep(log, failed.step)}\n`,
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error: unknown) {
    console.error("[ci:fail]", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
