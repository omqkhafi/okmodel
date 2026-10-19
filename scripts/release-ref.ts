/**
 * The tag the Release workflow may stage.
 *
 * A tag push publishes only when the tagged commit is an ancestor of
 * `origin/main`, the tag is `v` plus the `package.json` version, and
 * `changelog.md` has a `## v` section for that version. A dry run
 * (`RELEASE_PUBLISH` unset or `false`) accepts `main` and refuses a tag
 * whose commit is not on `main`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { changelogReleaseNotes } from "./github-release.js";
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
  return `Refusing to publish from ${shown}. package.json is ${version}, so the tag must be v${version}. Run: git push origin "v${version}"`;
}

/**
 * Whether this run should stage the package.
 *
 * Tag pushes set `RELEASE_PUBLISH=true`. A workflow dispatch sets it from
 * the `publish` input. Anything else is a dry run.
 *
 * @param value - `RELEASE_PUBLISH`
 * @returns True only for the exact string `true`
 */
export function releasePublishRequested(value: string | undefined): boolean {
  return value === "true";
}

/**
 * Exit code of `git merge-base --is-ancestor HEAD origin/main`.
 *
 * @param cwd - Repository to test
 * @returns The git exit code, or 1 when git did not report one
 */
export function mainAncestorStatus(cwd: string): number {
  const proc = Bun.spawnSync(["git", "merge-base", "--is-ancestor", "HEAD", "origin/main"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode ?? 1;
}

/**
 * Why this ref may not continue past the release guard.
 *
 * The ancestor check always runs. A tag must also match `package.json` and
 * have a changelog section. A dry run that is not a tag stops after the
 * ancestor check, so `main` passes and a branch tag fails.
 *
 * @param input - Ref, version, changelog text, ancestor result, and whether this run publishes
 * @returns Refusal lines. Empty when the run may continue
 */
export function releaseGuardProblems(input: {
  readonly ref: string | undefined;
  readonly version: string;
  readonly changelog: string;
  /** True when `git merge-base --is-ancestor HEAD origin/main` exits 0. */
  readonly onMain: boolean;
  readonly publish: boolean;
}): readonly string[] {
  const problems: string[] = [];
  if (!input.onMain) {
    problems.push(
      "Refusing to publish. HEAD is not an ancestor of origin/main. git merge-base --is-ancestor failed, so this commit is not on main.",
    );
  }
  const isTag = input.ref?.startsWith("refs/tags/") === true;
  if (!isTag) {
    if (input.publish) {
      const shown = input.ref === undefined || input.ref.length === 0 ? "(unset)" : input.ref;
      problems.push(
        `Refusing to publish from ${shown}. package.json is ${input.version}, so the tag must be v${input.version}. Run: git push origin "v${input.version}"`,
      );
    }
    return problems;
  }
  const refProblem = releaseRefProblem(input.ref, input.version);
  if (refProblem !== undefined) problems.push(refProblem);
  try {
    changelogReleaseNotes(input.changelog, input.version);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "changelog.md has no section for this version";
    problems.push(message);
  }
  return problems;
}

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

/**
 * Fetches `origin/main` when this checkout has no remote-tracking ref.
 *
 * @param cwd - Repository root
 * @returns The fetch error, or undefined when `origin/main` is present
 */
function ensureOriginMain(cwd: string): string | undefined {
  const has = Bun.spawnSync(
    ["git", "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (has.exitCode === 0) return undefined;
  const fetched = Bun.spawnSync(["git", "fetch", "origin", "main"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (fetched.exitCode === 0) return undefined;
  const detail = fetched.stderr.toString().trim();
  return detail.length > 0 ? detail : "git fetch origin main failed";
}

if (import.meta.main) {
  const root = repoRoot();
  const missing = ensureOriginMain(root);
  if (missing !== undefined) {
    exitOnProblems([`Refusing to publish. origin/main is not available. ${missing}`]);
  }
  const version = readVersion(root);
  const changelog = readFileSync(join(root, "changelog.md"), "utf8");
  const problems = releaseGuardProblems({
    ref: process.env.GITHUB_REF,
    version,
    changelog,
    onMain: mainAncestorStatus(root) === 0,
    publish: releasePublishRequested(process.env.RELEASE_PUBLISH),
  });
  exitOnProblems(problems);
  console.log(`${process.env.GITHUB_REF ?? "(unset)"} is on main at ${version}`);
}
