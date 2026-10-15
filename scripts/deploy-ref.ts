/**
 * The commit a production site deploy may publish.
 *
 * A manual run passes a `v*` tag. A run after Release uses that workflow's
 * commit and the tag it was dispatched on. The tag check is
 * {@link releaseRefProblem}: `refs/tags/v` plus the `package.json` version at
 * that commit. A prerelease suffix is refused here and is still accepted by
 * the Release workflow. The workflow then moves `refs/heads/release` to that
 * commit, and the confirm step fetches the origin declared in
 * `site/lib/site-identity.ts`.
 *
 *   bun ./scripts/deploy-ref.ts
 *   DEPLOY_VERSION=0.7.0 bun ./scripts/deploy-ref.ts --confirm
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { releaseRefProblem } from "./release-ref.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

/** `v` plus `X.Y.Z`, with an optional prerelease or build suffix. */
const TAG_NAME =
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Pauses before each fetch of the production page.
 *
 * The first try does not wait. The later pauses grow from 10 seconds to 60
 * seconds and then stay at 60 seconds. Their sum stays inside
 * {@link DEPLOY_FETCH_BUDGET_MS}.
 */
export const DEPLOY_FETCH_WAITS_MS = [
  0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
  60_000, 60_000,
] as const;

/** Twelve minutes. A production build is allowed this long to show the version. */
export const DEPLOY_FETCH_BUDGET_MS = 12 * 60 * 1000;

/** How long one fetch may take. */
const FETCH_TIMEOUT_MS = 15_000;

/** The default origin written beside `SITE_ORIGIN` in `site/lib/site-identity.ts`. */
const DECLARED_ORIGIN =
  /export const SITE_ORIGIN = \(\s*process\.env\.SITE_ORIGIN \?\? "(https:\/\/[^"]+)"/;

/**
 * The production origin `site/lib/site-identity.ts` declares.
 *
 * The site module stays out of this script. The confirm step reads that
 * declaration so the URL is not copied here.
 *
 * @param source - Contents of `site/lib/site-identity.ts`
 * @returns The default origin, with no trailing slash
 */
export function declaredSiteOrigin(source: string): string {
  const origin = DECLARED_ORIGIN.exec(source)?.[1];
  if (origin === undefined) {
    throw new Error(
      "site/lib/site-identity.ts does not declare a default https origin for SITE_ORIGIN.",
    );
  }
  return origin.replace(/\/$/, "");
}

/**
 * The GitHub event the deploy workflow is resolving.
 */
export type DeployEvent = {
  /** `workflow_dispatch` or `workflow_run`. */
  readonly eventName: string;
  /** Manual `tag` input. Empty on a Release run. */
  readonly inputTag: string | undefined;
  /** `workflow_run.head_branch`. A Release dispatched on a tag reports the tag name. */
  readonly headBranch: string | undefined;
};

/**
 * A resolved string, or a refusal.
 */
export type DeployText =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly problem: string };

/**
 * The tag name for this run.
 *
 * A manual run uses the `tag` input. A Release run uses `head_branch`, which
 * is the tag name when Release is started on a tag.
 *
 * @param event - Event name and the ref fields the workflow passes
 * @returns The tag without `refs/tags/`, or a refusal
 */
export function resolveDeployTag(event: DeployEvent): DeployText {
  if (event.eventName === "workflow_dispatch") {
    const raw = (event.inputTag ?? "").trim();
    if (raw.length === 0) {
      return { ok: false, problem: "A tag is required. Pass a v* tag, for example v0.7.0." };
    }
    return tagResult(raw);
  }
  if (event.eventName === "workflow_run") {
    const branch = (event.headBranch ?? "").trim();
    if (branch.length === 0) {
      return {
        ok: false,
        problem:
          "Refusing to deploy from (unset). The Release workflow must run on a tag v<version>.",
      };
    }
    return tagResult(branch);
  }
  const shown = event.eventName.length === 0 ? "(unset)" : event.eventName;
  return { ok: false, problem: `Refusing to deploy from event ${shown}.` };
}

/**
 * Refuses a version that has a semver prerelease suffix.
 *
 * `0.7.0-next.106` is refused. `0.7.0` and `0.7.0+build` are not.
 *
 * @param version - `package.json` version at the commit being deployed
 * @returns The refusal, or undefined when the version is a release
 */
export function prereleaseProblem(version: string): string | undefined {
  const withoutBuild = version.split("+")[0] ?? version;
  if (!withoutBuild.includes("-")) return undefined;
  return `Refusing to deploy ${version}. The production site deploys only a release version (X.Y.Z), not a prerelease.`;
}

/**
 * Tag and prerelease problems for one commit.
 *
 * The tag half is {@link releaseRefProblem}. Release still accepts a
 * prerelease tag; this list adds the refusal.
 *
 * @param tag - Tag name, with or without `refs/tags/`
 * @param version - `package.json` version at that commit
 * @returns Refusal lines. Empty when the tag matches and the version is a release
 */
export function deployRefProblems(tag: string, version: string): readonly string[] {
  const ref = tag.startsWith("refs/tags/") ? tag : `refs/tags/${tag}`;
  const problems: string[] = [];
  const refProblem = releaseRefProblem(ref, version);
  if (refProblem !== undefined) problems.push(refProblem);
  const prerelease = prereleaseProblem(version);
  if (prerelease !== undefined) problems.push(prerelease);
  return problems;
}

/**
 * Refuses a tag that does not point at the Release commit.
 *
 * @param tag - Tag name
 * @param tagCommit - Commit the tag points at
 * @param headSha - `workflow_run.head_sha`, or empty when this is a manual run
 * @returns The refusal, or undefined when there is nothing to compare or they match
 */
export function tagCommitProblem(
  tag: string,
  tagCommit: string,
  headSha: string | undefined,
): string | undefined {
  if (headSha === undefined || headSha.length === 0) return undefined;
  if (tagCommit === headSha) return undefined;
  return `Tag ${tag} points at ${tagCommit}, but the Release run was ${headSha}.`;
}

/**
 * Whether the page text contains `version` as its own version.
 *
 * A following `-`, digit, or dot does not count, so `0.7.0` does not match
 * `0.7.0-next.106`.
 *
 * @param body - Response body
 * @param version - `package.json` version that was deployed
 * @returns Whether that version is present
 */
export function pageContainsVersion(body: string, version: string): boolean {
  if (version.length === 0) return false;
  let from = 0;
  while (from <= body.length) {
    const at = body.indexOf(version, from);
    if (at < 0) return false;
    const next = body[at + version.length];
    if (next === undefined || !/[0-9A-Za-z.+-]/.test(next)) return true;
    from = at + version.length;
  }
  return false;
}

/**
 * Fetches the production page until it contains `version`, or the wait budget ends.
 *
 * @param url - Production URL
 * @param version - `package.json` version that was deployed
 * @param attempts - Fetch and sleep. Tests pass fakes; the workflow uses the network
 * @returns Nothing when the page contains the version
 */
export async function confirmDeployedVersion(
  url: string,
  version: string,
  attempts: {
    readonly fetchPage: (url: string) => Promise<string>;
    readonly sleep: (ms: number) => Promise<void>;
    readonly waitsMs?: readonly number[];
    readonly budgetMs?: number;
  },
): Promise<void> {
  if (!url.startsWith("https://")) {
    throw new Error(`Refusing to fetch ${url}. The production URL must be https.`);
  }
  const waits = attempts.waitsMs ?? DEPLOY_FETCH_WAITS_MS;
  const budget = attempts.budgetMs ?? DEPLOY_FETCH_BUDGET_MS;
  let waited = 0;
  let last = `Deployed page ${url} does not contain ${version}.`;
  for (const wait of waits) {
    if (wait > 0) {
      if (waited + wait > budget) break;
      await attempts.sleep(wait);
      waited += wait;
    }
    try {
      const body = await attempts.fetchPage(url);
      if (pageContainsVersion(body, version)) return;
      last = `Deployed page ${url} does not contain ${version}.`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(
    `${last} The production site did not show ${version} within ${String(budget)} ms. Waited ${String(waited)} ms.`,
  );
}

function tagResult(raw: string): DeployText {
  const tag = raw.startsWith("refs/tags/") ? raw.slice("refs/tags/".length) : raw;
  if (!TAG_NAME.test(tag)) {
    return {
      ok: false,
      problem: `Refusing to deploy from ${raw}. Pass a tag v<version>, for example v0.7.0.`,
    };
  }
  return { ok: true, value: tag };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gitOutput(args: readonly string[]): {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/**
 * Commit a tag points at.
 *
 * @param tag - Tag name that already matched the `v<version>` pattern
 * @returns The peeled commit
 */
function commitAtTag(tag: string): string {
  const listed = gitOutput(["show-ref", "--verify", "--", `refs/tags/${tag}`]);
  if (listed.code !== 0) {
    throw new Error(`Tag ${tag} does not exist. Push the tag, then deploy that tag.`);
  }
  const parsed = gitOutput(["rev-parse", "--verify", "--end-of-options", `${tag}^{commit}`]);
  if (parsed.code !== 0) {
    const detail = parsed.stderr.trim();
    throw new Error(detail.length > 0 ? detail : `Tag ${tag} does not point at a commit.`);
  }
  const sha = parsed.stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(
      `Tag ${tag} resolved to ${sha.length === 0 ? "(empty)" : sha}, which is not a commit.`,
    );
  }
  return sha;
}

/**
 * `package.json` version at a commit.
 *
 * @param sha - Full commit
 * @returns The version string
 */
function versionAtCommit(sha: string): string {
  const shown = gitOutput(["show", `${sha}:package.json`]);
  if (shown.code !== 0) {
    throw new Error(`package.json is missing at ${sha}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(shown.stdout) as unknown;
  } catch {
    throw new Error(`package.json at ${sha} is not JSON.`);
  }
  if (!isRecord(parsed) || typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`package.json at ${sha} has no version.`);
  }
  return parsed.version;
}

function writeOutput(lines: readonly string[]): void {
  const path = process.env.GITHUB_OUTPUT;
  if (path === undefined || path.length === 0) return;
  appendFileSync(path, `${lines.join("\n")}\n`);
}

/**
 * Resolves the release commit and writes `sha`, `tag`, and `version`.
 */
function resolveDeploy(): void {
  const eventName = process.env.DEPLOY_EVENT ?? "";
  const resolved = resolveDeployTag({
    eventName,
    inputTag: process.env.DEPLOY_TAG,
    headBranch: process.env.DEPLOY_HEAD_BRANCH,
  });
  if (!resolved.ok) {
    exitOnProblems([resolved.problem]);
    return;
  }
  const tag = resolved.value;
  const tagSha = commitAtTag(tag);
  let sha = tagSha;
  if (eventName === "workflow_run") {
    const head = (process.env.DEPLOY_HEAD_SHA ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(head)) {
      exitOnProblems(["The Release run did not report a commit."]);
      return;
    }
    const mismatch = tagCommitProblem(tag, tagSha, head);
    if (mismatch !== undefined) {
      exitOnProblems([mismatch]);
      return;
    }
    sha = head;
  }
  const version = versionAtCommit(sha);
  const problems = deployRefProblems(tag, version);
  exitOnProblems([...problems]);
  writeOutput([`sha=${sha}`, `tag=${tag}`, `version=${version}`]);
  console.log(`${tag} (${version}) at ${sha}`);
}

/**
 * Fetches the production origin until the page contains `DEPLOY_VERSION`.
 */
async function confirmDeploy(): Promise<void> {
  const version = process.env.DEPLOY_VERSION ?? "";
  if (version.length === 0) throw new Error("DEPLOY_VERSION is unset.");
  const source = readFileSync(join(repoRoot(), "site/lib/site-identity.ts"), "utf8");
  const origin = declaredSiteOrigin(source);
  await confirmDeployedVersion(origin, version, {
    fetchPage: fetchPage,
    sleep: (ms) => Bun.sleep(ms),
  });
  console.log(`Deployed ${origin} at ${version}`);
}

/**
 * GET one page.
 *
 * @param url - `https` URL
 * @returns The response body
 */
async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${String(response.status)}.`);
  }
  return response.text();
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      confirm: { type: "boolean", default: false },
    },
  });
  try {
    if (values.confirm) await confirmDeploy();
    else resolveDeploy();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitOnProblems([message]);
  }
}
