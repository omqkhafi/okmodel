/**
 * Copies the milestone from `Closes #N` onto the pull request when it has none.
 *
 * D206: the pull request milestone is the issue milestone. Cursor agents cannot
 * PATCH milestones (403); CI runs this before `pr-lint`.
 *
 * Usage:
 *   bun ./scripts/pr-sync-milestone.ts --pr <number>
 */

import { parseArgs } from "node:util";

/**
 * The issue number from the last `Closes #N` line in the pull request body.
 *
 * Content after `<!-- CURSOR_AGENT_PR_BODY_END -->` is ignored.
 *
 * @param body - Pull request body
 * @returns Issue number, or undefined when none
 */
export function closesIssueNumber(body: string): number | undefined {
  const end = body.indexOf("<!-- CURSOR_AGENT_PR_BODY_END -->");
  const text = (end === -1 ? body : body.slice(0, end)).replace(/\r\n/g, "\n").trimEnd();
  const lines = text.split("\n");
  const last = (lines[lines.length - 1] ?? "").trim();
  const match = /^Closes #(\d+)$/.exec(last);
  if (match === null || match[1] === undefined) return undefined;
  return Number(match[1]);
}

/**
 * Sets the pull request milestone from its `Closes #N` issue when unset.
 *
 * @param repo - `owner/name`
 * @param number - Pull request number
 * @param token - A token that can read issues and write the pull request
 */
export async function syncMilestoneFromCloses(
  repo: string,
  number: number,
  token: string,
): Promise<void> {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const pullResponse = await fetch(`https://api.github.com/repos/${repo}/pulls/${String(number)}`, {
    headers,
  });
  if (!pullResponse.ok) {
    throw new Error(`GitHub pull ${String(number)} returned ${String(pullResponse.status)}`);
  }
  const pull: unknown = await pullResponse.json();
  if (!isRecord(pull)) throw new Error("GitHub pull payload is not an object");
  if (pull.milestone !== null && pull.milestone !== undefined) {
    console.log(`[pr-sync-milestone] pull #${String(number)} already has a milestone`);
    return;
  }
  const body = typeof pull.body === "string" ? pull.body : "";
  const issueNumber = closesIssueNumber(body);
  if (issueNumber === undefined) {
    console.log(`[pr-sync-milestone] pull #${String(number)} has no Closes #N line`);
    return;
  }
  const issueResponse = await fetch(
    `https://api.github.com/repos/${repo}/issues/${String(issueNumber)}`,
    { headers },
  );
  if (!issueResponse.ok) {
    throw new Error(`GitHub issue ${String(issueNumber)} returned ${String(issueResponse.status)}`);
  }
  const issue: unknown = await issueResponse.json();
  if (!isRecord(issue)) throw new Error("GitHub issue payload is not an object");
  const milestone = issue.milestone;
  if (!isRecord(milestone) || typeof milestone.number !== "number") {
    console.log(`[pr-sync-milestone] issue #${String(issueNumber)} has no milestone`);
    return;
  }
  const patch = await fetch(`https://api.github.com/repos/${repo}/issues/${String(number)}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ milestone: milestone.number }),
  });
  if (!patch.ok) {
    throw new Error(
      `GitHub set milestone on pull #${String(number)} returned ${String(patch.status)}`,
    );
  }
  const title = typeof milestone.title === "string" ? milestone.title : String(milestone.number);
  console.log(
    `[pr-sync-milestone] set pull #${String(number)} milestone to ${title} from #${String(issueNumber)}`,
  );
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
      console.error("[pr-sync-milestone] Usage: bun ./scripts/pr-sync-milestone.ts --pr <number>");
      process.exit(2);
    }
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (token === undefined || token.length === 0) {
      console.error("[pr-sync-milestone] GH_TOKEN or GITHUB_TOKEN is required");
      process.exit(2);
    }
    const repo = process.env.GITHUB_REPOSITORY ?? "omqkhafi/okmodel";
    await syncMilestoneFromCloses(repo, number, token);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pr-sync-milestone] ${message}`);
    process.exit(1);
  }
}
