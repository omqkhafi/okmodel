/**
 * The tag the Release workflow may publish.
 *
 * The tag is `v` plus the `package.json` version at the QA'd commit. The
 * `commit` input is that commit's full 40-hex SHA. Any other ref, a tag that
 * peels to a different commit, or a checkout of a different commit is refused.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

/** A full git commit SHA. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The QA'd commit, lowercase, when `commit` is a full 40-hex SHA.
 *
 * @param commit - Workflow `commit` input
 * @returns The SHA, or undefined when it is not a full SHA
 */
export function releaseCommitSha(commit: string | undefined): string | undefined {
  const shown = commit?.trim().toLowerCase() ?? "";
  if (!COMMIT_SHA.test(shown)) return undefined;
  return shown;
}

/**
 * Refuses a workflow commit input that is not a full 40-hex SHA.
 *
 * @param commit - Workflow `commit` input
 * @returns The refusal, or undefined when the input is that SHA
 */
export function releaseCommitProblem(commit: string | undefined): string | undefined {
  if (releaseCommitSha(commit) !== undefined) return undefined;
  const raw = commit?.trim() ?? "";
  const display = raw.length === 0 ? "(unset)" : raw;
  return `Refusing to publish. The commit input must be the full 40-hex SHA of the QA'd commit, not ${display}.`;
}

/**
 * Refuses when a tag does not peel to the QA'd commit.
 *
 * @param tag - Tag name, without `refs/tags/`
 * @param tagCommit - Commit the tag peels to
 * @param qaCommit - QA'd commit
 * @returns The refusal, or undefined when both are that same full SHA
 */
export function releaseTagCommitProblem(
  tag: string,
  tagCommit: string,
  qaCommit: string,
): string | undefined {
  const resolved = tagCommit.trim().toLowerCase();
  const qa = qaCommit.trim().toLowerCase();
  if (resolved === qa && COMMIT_SHA.test(qa)) return undefined;
  const shown = (value: string): string => (value.length === 0 ? "(unset)" : value);
  return `Refusing to publish. Tag ${tag} points at ${shown(resolved)}, not the QA'd commit ${shown(qa)}.`;
}

/**
 * Refuses a workflow ref that is not `refs/tags/v` plus `version`.
 *
 * @param ref - `GITHUB_REF`, such as `refs/tags/v0.1.1`
 * @param version - `package.json` version at the commit being published, such as `0.1.1`
 * @returns The refusal, or undefined when the ref is that tag
 */
export function releaseRefProblem(ref: string | undefined, version: string): string | undefined {
  const expected = `refs/tags/v${version}`;
  if (ref === expected) return undefined;
  const shown = ref === undefined || ref.length === 0 ? "(unset)" : ref;
  return `Refusing to publish from ${shown}. package.json is ${version}, so the tag must be v${version}. Run: gh workflow run release.yml --ref "v${version}" -f commit=<sha>`;
}

/** A git command's stdout, or the refusal to show. */
type GitText =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly problem: string };

function readVersion(root: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error("package.json has no version");
  }
  const version = parsed.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json version is not a string");
  }
  return version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Runs git in the repository and returns trimmed stdout.
 *
 * @param args - Git arguments
 * @returns Stdout, or the git error
 */
function gitText(args: readonly string[]): GitText {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: repoRoot(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const detail = proc.stderr.toString().trim();
    return { ok: false, problem: detail.length > 0 ? detail : `git ${args.join(" ")} failed` };
  }
  return { ok: true, text: proc.stdout.toString().trim() };
}

/**
 * The commit a ref peels to.
 *
 * @param ref - A tag, `HEAD`, or other commit-ish
 * @returns The full lowercase SHA, or why it did not peel
 */
function commitOf(ref: string): GitText {
  const parsed = gitText(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!parsed.ok) return parsed;
  const sha = parsed.text.toLowerCase();
  if (!COMMIT_SHA.test(sha)) {
    return {
      ok: false,
      problem: `${ref} resolved to ${sha.length === 0 ? "(empty)" : sha}, which is not a commit.`,
    };
  }
  return { ok: true, text: sha };
}

/**
 * `package.json` version at a commit.
 *
 * @param sha - Full commit that is already in this checkout
 * @returns The version string, or why it could not be read
 */
function versionAt(sha: string): GitText {
  const shown = gitText(["show", `${sha}:package.json`]);
  if (!shown.ok) return { ok: false, problem: `package.json is missing at ${sha}.` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(shown.text) as unknown;
  } catch {
    return { ok: false, problem: `package.json at ${sha} is not JSON.` };
  }
  if (!isRecord(parsed) || typeof parsed.version !== "string" || parsed.version.length === 0) {
    return { ok: false, problem: `package.json at ${sha} has no version.` };
  }
  return { ok: true, text: parsed.version };
}

/**
 * Tag name from `GITHUB_REF`, without `refs/tags/`.
 *
 * @param ref - `GITHUB_REF`
 * @returns The tag, or undefined when the ref is not a tag
 */
function tagName(ref: string | undefined): string | undefined {
  if (ref === undefined || !ref.startsWith("refs/tags/")) return undefined;
  const name = ref.slice("refs/tags/".length);
  return name.length === 0 ? undefined : name;
}

/**
 * Why this workflow ref may not publish.
 *
 * @param ref - `GITHUB_REF`
 * @param commit - Workflow `commit` input
 * @returns Refusal lines. Empty when the tag, the checkout, and `package.json` agree
 */
function releaseProblems(ref: string | undefined, commit: string | undefined): readonly string[] {
  const qa = releaseCommitSha(commit);
  if (qa === undefined) {
    return [releaseCommitProblem(commit) ?? "Refusing to publish."];
  }
  const tag = tagName(ref);
  if (tag === undefined) {
    const version = readVersion(repoRoot());
    const problem = releaseRefProblem(ref, version);
    return [problem ?? "Refusing to publish. The workflow ref is not a tag."];
  }
  const peeled = commitOf(`refs/tags/${tag}`);
  if (!peeled.ok) return [`Tag ${tag} does not resolve to a commit. ${peeled.problem}`];
  const problems: string[] = [];
  const mismatch = releaseTagCommitProblem(tag, peeled.text, qa);
  if (mismatch !== undefined) problems.push(mismatch);
  const head = commitOf("HEAD");
  if (!head.ok) problems.push(`The checkout does not resolve to a commit. ${head.problem}`);
  else if (head.text !== qa) {
    problems.push(`Refusing to publish. The checkout is ${head.text}, not the QA'd commit ${qa}.`);
  }
  const version = versionAt(peeled.text);
  if (!version.ok) problems.push(version.problem);
  else {
    const refProblem = releaseRefProblem(ref, version.text);
    if (refProblem !== undefined) problems.push(refProblem);
  }
  return problems;
}

if (import.meta.main) {
  const problems = releaseProblems(process.env.GITHUB_REF, process.env.RELEASE_COMMIT);
  exitOnProblems(problems);
  if (problems.length === 0) {
    console.log(`${process.env.GITHUB_REF} at ${releaseCommitSha(process.env.RELEASE_COMMIT)}`);
  }
}
