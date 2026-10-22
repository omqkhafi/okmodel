/**
 * Opens or updates the one issue for a failure after merge.
 *
 * A push to `main` and the nightly run share one open issue. A later failure
 * comments on it. A green run does not close it.
 *
 *   bun ./scripts/ci-issue.ts lint=failure suite=success
 */

import { parseArgs } from "node:util";

/** Title of the single after-merge failure issue. */
export const CI_FAILURE_TITLE = "CI failed after merge";

/** One job result. */
export type JobResult = {
  readonly name: string;
  readonly result: string;
};

/**
 * Jobs that failed or were cancelled.
 *
 * @param results - `name=result` pairs from the workflow
 * @returns The names, in input order
 */
export function failedJobs(results: readonly JobResult[]): readonly string[] {
  return results
    .filter((job) => job.result === "failure" || job.result === "cancelled")
    .map((job) => job.name);
}

/**
 * The open issue to update, when one already has the stable title.
 *
 * @param issues - Open issues, titles and numbers
 * @param title - {@link CI_FAILURE_TITLE}
 * @returns The issue number, or undefined when none is open
 */
export function pickOpenIssue(
  issues: readonly { readonly number: number; readonly title: string }[],
  title: string,
): number | undefined {
  return issues.find((issue) => issue.title === title)?.number;
}

/**
 * Parses `name=result` arguments.
 *
 * @param args - Arguments after the flags
 * @returns The pairs, in order
 */
export function parseJobResults(args: readonly string[]): readonly JobResult[] {
  const results: JobResult[] = [];
  for (const arg of args) {
    if (!arg.includes("=")) continue;
    const eq = arg.indexOf("=");
    const name = arg.slice(0, eq);
    const result = arg.slice(eq + 1);
    if (name.length === 0 || result.length === 0) {
      throw new Error("usage: bun ./scripts/ci-issue.ts <name=result>...");
    }
    results.push({ name, result });
  }
  return results;
}

function gh(args: readonly string[]): string {
  const proc = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString().trim() || `gh ${args.join(" ")} failed`);
  }
  return proc.stdout.toString();
}

if (import.meta.main) {
  try {
    const { positionals } = parseArgs({ allowPositionals: true, args: process.argv.slice(2) });
    const failed = failedJobs(parseJobResults(positionals));
    if (failed.length === 0) {
      console.log("[ci-issue] no failing job");
      process.exit(0);
    }
    const repo = process.env.GITHUB_REPOSITORY ?? "omqkhafi/okmodel";
    const sha = process.env.GITHUB_SHA ?? "";
    const run = process.env.GITHUB_RUN_ID ?? "";
    const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
    const url = `${server}/${repo}/actions/runs/${run}`;
    const body = [`Jobs: ${failed.join(", ")}`, "", `Run: ${url}`, `Commit: ${sha}`].join("\n");
    const listed = JSON.parse(
      gh([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,title",
      ]),
    ) as unknown;
    if (!Array.isArray(listed)) throw new Error("issue list is not an array");
    const issues: { number: number; title: string }[] = [];
    for (const item of listed) {
      if (
        typeof item === "object" &&
        item !== null &&
        "number" in item &&
        "title" in item &&
        typeof item.number === "number" &&
        typeof item.title === "string"
      ) {
        issues.push({ number: item.number, title: item.title });
      }
    }
    const existing = pickOpenIssue(issues, CI_FAILURE_TITLE);
    if (existing === undefined) {
      gh(["issue", "create", "--repo", repo, "--title", CI_FAILURE_TITLE, "--body", body]);
      console.log("[ci-issue] opened");
    } else {
      gh(["issue", "comment", String(existing), "--repo", repo, "--body", body]);
      console.log(`[ci-issue] updated #${String(existing)}`);
    }
  } catch (error: unknown) {
    console.error("[ci-issue]", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
