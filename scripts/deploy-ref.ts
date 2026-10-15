/**
 * The commit a production site deploy may build.
 *
 * A manual run passes a `v*` tag. A run after Release uses that workflow's
 * commit and the tag it was dispatched on. The tag check is
 * {@link releaseRefProblem}: `refs/tags/v` plus the `package.json` version at
 * that commit. A prerelease suffix is refused here and is still accepted by
 * the Release workflow.
 *
 *   bun ./scripts/deploy-ref.ts
 *   DEPLOY_JSON=vercel-deploy.json DEPLOY_VERSION=0.7.0 bun ./scripts/deploy-ref.ts --confirm
 */

import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { releaseRefProblem } from "./release-ref.js";
import { exitOnProblems } from "./report.js";

/** `v` plus `X.Y.Z`, with an optional prerelease or build suffix. */
const TAG_NAME =
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Pauses before each fetch of the production page. The first try does not wait. */
export const DEPLOY_FETCH_WAITS_MS = [0, 5_000, 10_000, 15_000, 20_000] as const;

/** Sleep between fetches never exceeds this. */
export const DEPLOY_FETCH_BUDGET_MS = 60_000;

/** How long one fetch may take. */
const FETCH_TIMEOUT_MS = 15_000;

/** A Release run is production. A manual run may rehearse on preview. */
export type DeployTarget = "production" | "preview";

/**
 * Vercel commands for one target.
 *
 * Preview does not pass `--prod` and does not fetch the page. The production
 * alias is only assigned for `production`.
 */
export type VercelDeployPlan = {
  /** `production` or `preview`. */
  readonly target: DeployTarget;
  /** `vercel pull --environment`. */
  readonly environment: DeployTarget;
  /** `--prod` for production. Empty for a preview rehearsal. */
  readonly prodFlag: "--prod" | "";
  /** Production checks the live page. Preview only prints the deployment URL. */
  readonly confirm: boolean;
};

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
 * Where this run deploys.
 *
 * `workflow_run` is production and ignores `input`. A manual run defaults to
 * production. `preview` is a rehearsal and does not alias the production domain.
 *
 * @param eventName - `workflow_dispatch` or `workflow_run`
 * @param input - Manual `target` input. Ignored on a Release run
 * @returns `production` or `preview`, or a refusal
 */
export function resolveDeployTarget(eventName: string, input: string | undefined): DeployText {
  if (eventName === "workflow_run") return { ok: true, value: "production" };
  if (eventName !== "workflow_dispatch") {
    const shown = eventName.length === 0 ? "(unset)" : eventName;
    return { ok: false, problem: `Refusing to deploy from event ${shown}.` };
  }
  const target = (input ?? "").trim();
  if (target.length === 0 || target === "production") return { ok: true, value: "production" };
  if (target === "preview") return { ok: true, value: "preview" };
  return { ok: false, problem: `Refusing target ${target}. Pass production or preview.` };
}

/**
 * Vercel flags for a resolved target.
 *
 * @param target - `production` or `preview`
 * @returns Environment, the `--prod` flag, and whether to fetch the page
 */
export function vercelDeployPlan(target: DeployTarget): VercelDeployPlan {
  if (target === "preview") {
    return { target, environment: "preview", prodFlag: "", confirm: false };
  }
  return { target: "production", environment: "production", prodFlag: "--prod", confirm: true };
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
 * The production URL from `vercel deploy --json`.
 *
 * Accepts the non-interactive wrapper (`status` plus `deployment`) and the
 * bare deployment object. A production deploy with no alias is a refusal.
 *
 * @param value - Parsed deploy JSON
 * @returns The `https` production URL, or a refusal
 */
export function productionUrlFromDeployOutput(value: unknown): DeployText {
  const deployment = deploymentOf(value);
  if (!deployment.ok) return deployment;
  const production = httpsUrl(deployment.value.productionUrl);
  if (production !== undefined) return { ok: true, value: production };
  const deploymentUrl = httpsUrl(deployment.value.url);
  const where = deploymentUrl === undefined ? "" : ` The deployment URL was ${deploymentUrl}.`;
  return { ok: false, problem: `Vercel did not return a production URL.${where}` };
}

/**
 * The deployment URL from `vercel deploy --json`.
 *
 * This is the unique deployment, not the production alias. A preview rehearsal
 * prints it and does not fetch it.
 *
 * @param value - Parsed deploy JSON
 * @returns The `https` deployment URL, or a refusal
 */
export function deploymentUrlFromDeployOutput(value: unknown): DeployText {
  const deployment = deploymentOf(value);
  if (!deployment.ok) return deployment;
  const url = httpsUrl(deployment.value.url);
  if (url !== undefined) return { ok: true, value: url };
  return { ok: false, problem: "Vercel did not return a deployment URL." };
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
  throw new Error(`${last} Waited ${String(waited)} ms.`);
}

/**
 * The deployment object, or a refusal when the CLI reported an error.
 *
 * @param value - Parsed deploy JSON
 * @returns The deployment record, or a refusal
 */
function deploymentOf(
  value: unknown,
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly problem: string } {
  if (!isRecord(value)) {
    return { ok: false, problem: "Vercel deploy output is not JSON." };
  }
  const status = value.status;
  if (status === "error" || status === "action_required") {
    const message = typeof value.message === "string" ? value.message : "Vercel deploy failed.";
    return { ok: false, problem: message };
  }
  return { ok: true, value: isRecord(value.deployment) ? value.deployment : value };
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

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^https:\/\/\S+$/.test(trimmed)) return undefined;
  return trimmed;
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
 * Resolves the release commit and writes `sha`, `tag`, `version`, and the Vercel target.
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
  const target = resolveDeployTarget(eventName, process.env.DEPLOY_TARGET);
  if (!target.ok) {
    exitOnProblems([target.problem]);
    return;
  }
  const plan = vercelDeployPlan(target.value === "preview" ? "preview" : "production");
  writeOutput([
    `sha=${sha}`,
    `tag=${tag}`,
    `version=${version}`,
    `target=${plan.target}`,
    `environment=${plan.environment}`,
    `prod_flag=${plan.prodFlag}`,
    `confirm=${plan.confirm ? "true" : "false"}`,
  ]);
  console.log(`${tag} (${version}) at ${sha} → ${plan.target}`);
}

/**
 * Prints the production URL and fails when the page does not contain the version.
 */
async function confirmDeploy(): Promise<void> {
  const version = process.env.DEPLOY_VERSION ?? "";
  if (version.length === 0) throw new Error("DEPLOY_VERSION is unset.");
  const url = productionUrlFromDeployOutput(readDeployJson());
  if (!url.ok) throw new Error(url.problem);
  await confirmDeployedVersion(url.value, version, {
    fetchPage: fetchPage,
    sleep: (ms) => Bun.sleep(ms),
  });
  console.log(`Deployed ${url.value} at ${version}`);
}

/**
 * Prints the preview deployment URL. Does not fetch it.
 */
function printPreviewUrl(): void {
  const url = deploymentUrlFromDeployOutput(readDeployJson());
  if (!url.ok) throw new Error(url.problem);
  console.log(url.value);
}

/**
 * Parsed `vercel deploy --json` output.
 *
 * @returns The JSON value
 */
function readDeployJson(): unknown {
  const jsonPath = process.env.DEPLOY_JSON ?? "";
  if (jsonPath.length === 0) throw new Error("DEPLOY_JSON is unset.");
  const raw = readFileSync(jsonPath, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Vercel deploy output is not JSON.");
    return JSON.parse(raw.slice(start, end + 1)) as unknown;
  }
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
      "preview-url": { type: "boolean", default: false },
    },
  });
  try {
    if (values.confirm && values["preview-url"]) {
      exitOnProblems(["Pass only one of --confirm and --preview-url."]);
    } else if (values.confirm) await confirmDeploy();
    else if (values["preview-url"]) printPreviewUrl();
    else resolveDeploy();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitOnProblems([message]);
  }
}
