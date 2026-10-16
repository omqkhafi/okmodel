/**
 * Creates or updates the sticky plan comment (D279).
 *
 * Uses `GITHUB_TOKEN` only. The workflow needs `pull-requests: write`.
 * The token is not written to stdout or stderr.
 */

import { readFileSync } from "node:fs";

import { planCommentBody, stickyCommentTarget, type StickyComment } from "./comment.js";

const PAGE = 100;

/**
 * Posts the plan comment for one pull request.
 *
 * An existing comment that contains the marker is updated. Otherwise a
 * comment is created. The body comes from {@link planCommentBody}.
 *
 * @param planPath - File written by `okm migrate plan --json`
 * @param checkStatus - Exit code of `okm migrate check`
 * @param planStatus - Exit code of `okm migrate plan --json`
 */
export async function postPlanComment(
  planPath: string,
  checkStatus: string,
  planStatus: string,
): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new Error("GITHUB_TOKEN is not set. The comment step needs pull-requests: write.");
  }
  const repository = required("GITHUB_REPOSITORY");
  const pull = required("PR_NUMBER");
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  let text: string | undefined;
  try {
    text = readFileSync(planPath, "utf8");
  } catch {
    text = undefined;
  }
  const body = planCommentBody(text, checkStatus, planStatus);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "okmodel-action",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const comments = await listComments(
    `${api}/repos/${repository}/issues/${pull}/comments`,
    headers,
  );
  const target = stickyCommentTarget(comments);
  const response =
    target === undefined
      ? await fetch(`${api}/repos/${repository}/issues/${pull}/comments`, {
          method: "POST",
          headers,
          body: JSON.stringify({ body }),
        })
      : await fetch(`${api}/repos/${repository}/issues/comments/${String(target.updateId)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ body }),
        });
  if (!response.ok) {
    throw new Error(`GitHub comment write failed (${String(response.status)}).`);
  }
  const verb = target === undefined ? "created" : "updated";
  process.stdout.write(`${verb} the plan comment\n`);
}

async function listComments(url: string, headers: HeadersInit): Promise<readonly StickyComment[]> {
  const comments: StickyComment[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(`${url}?per_page=${String(PAGE)}&page=${String(page)}`, {
      headers,
    });
    if (!response.ok) {
      throw new Error(`GitHub comment list failed (${String(response.status)}).`);
    }
    const parsed: unknown = await response.json();
    if (!Array.isArray(parsed)) throw new Error("GitHub comment list was not an array.");
    for (const item of parsed) {
      if (!isComment(item)) continue;
      comments.push({ id: item.id, body: item.body });
    }
    if (parsed.length < PAGE) break;
  }
  return comments;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

function isComment(value: unknown): value is { readonly id: number; readonly body: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "number" && typeof record.body === "string";
}

if (import.meta.main) {
  const planPath = process.argv[2] ?? "";
  const checkStatus = process.argv[3] ?? "0";
  const planStatus = process.argv[4] ?? "0";
  try {
    await postPlanComment(planPath, checkStatus, planStatus);
  } catch (error) {
    const message = error instanceof Error ? error.message : "comment failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
