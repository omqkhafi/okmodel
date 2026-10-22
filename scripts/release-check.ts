/**
 * A pull request leaves `package.json` and `changelog.md` alone.
 *
 * Notes are generated when a release promotes `## Unreleased`. `bump next
 * --publish` may move the version to the next prerelease and must not edit
 * the changelog. A release that drops a `-next.N` suffix, a bare version cut
 * with notes under the new heading, and an untagged release that folds notes
 * into its heading are still allowed.
 *
 * A pull request whose changed files are all under `.github/` is exempt
 * (see {@link releaseExemption}). Any file outside `.github/` is checked.
 *
 * Usage:
 *   bun ./scripts/release-check.ts --base <git-rev>
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { nextVersion } from "./bump-version.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

/** Package version and changelog text for one side of a pull request. */
export type ReleaseSnapshot = {
  readonly version: string;
  readonly changelog: string;
};

/** When the release version is not tagged yet, notes may land under its heading. */
export type ReleaseCheckOptions = {
  /**
   * `vX.Y.Z` is not a git tag. Notes added under `## vX.Y.Z` are the release,
   * and the version may stay `X.Y.Z`.
   */
  readonly untaggedRelease?: boolean;
};

/**
 * Compares a head snapshot with its base.
 *
 * @param base - Version and changelog on the base branch
 * @param head - Version and changelog on the pull request
 * @param options - Allows notes on an untagged release heading
 * @returns Problem lines. Empty when the pull request leaves the release files, publishes a prerelease, or cuts a release
 */
export function checkReleaseSnapshots(
  base: ReleaseSnapshot,
  head: ReleaseSnapshot,
  options?: ReleaseCheckOptions,
): readonly string[] {
  const headSection = unreleasedSection(head.changelog);
  if (!headSection.found) {
    return ["changelog.md has no ## Unreleased section"];
  }
  const preTag = options?.untaggedRelease === true && hasNewReleaseNotes(base, head);
  const folded = options?.untaggedRelease === true && isFoldedUntaggedRelease(base, head);
  if (isReleasePromotion(base, head) || isBareReleaseCut(base, head) || preTag || folded) {
    return [];
  }
  const notesAdded = hasNewUnreleasedLines(base.changelog, head.changelog);
  const changedLog = normalize(base.changelog) !== normalize(head.changelog);
  const sameVersion = head.version === base.version;
  let prerelease = false;
  try {
    prerelease = head.version === nextVersion(base.version);
  } catch {
    prerelease = false;
  }
  if ((sameVersion || prerelease) && !notesAdded && !changedLog) return [];
  const problems: string[] = [];
  if (!sameVersion && !prerelease) {
    problems.push(
      `package.json version changed from ${base.version} to ${head.version}; bump next --publish is only for a prerelease`,
    );
  }
  if (notesAdded || changedLog) {
    problems.push("changelog.md changed; notes are generated at release");
  }
  return problems;
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * The reason a change needs no version bump and no changelog line, or undefined.
 *
 * A pull request whose changed files are all under `.github/` (workflows,
 * templates) changes no shipped code. An empty list is not exempt: it is
 * checked as before.
 *
 * @param changedFiles - Repository-relative paths the pull request changes
 * @returns The line to print when exempt, otherwise undefined
 */
export function releaseExemption(changedFiles: readonly string[]): string | undefined {
  if (changedFiles.length === 0) return undefined;
  if (!changedFiles.every((file) => file.startsWith(".github/"))) return undefined;
  return "only .github/ changed: no version bump or changelog needed";
}

/**
 * Reads `package.json` and `changelog.md` from a fixture directory.
 *
 * @param dir - Directory that contains both files
 * @returns The snapshot those files describe
 */
export function readReleaseSnapshot(dir: string): ReleaseSnapshot {
  return {
    version: readVersion(readFileSync(join(dir, "package.json"), "utf8"), dir),
    changelog: readFileSync(join(dir, "changelog.md"), "utf8"),
  };
}

/**
 * Runs {@link checkReleaseSnapshots} on two fixture directories.
 *
 * @param baseDir - Base fixture
 * @param headDir - Head fixture
 * @returns Problem lines
 */
export function checkReleaseDirs(baseDir: string, headDir: string): readonly string[] {
  return checkReleaseSnapshots(readReleaseSnapshot(baseDir), readReleaseSnapshot(headDir));
}

function readVersion(packageJson: string, label: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} package.json is not valid JSON: ${message}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error(`${label} package.json has no version`);
  }
  const version = parsed.version;
  if (typeof version !== "string") {
    throw new Error(`${label} package.json version is not a string`);
  }
  return version;
}

function unreleasedSection(changelog: string): {
  readonly found: boolean;
  readonly lines: readonly string[];
} {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^## Unreleased\s*$/.test(line));
  if (start === -1) return { found: false, lines: [] };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return { found: true, lines: lines.slice(start + 1, end) };
}

function hasNewUnreleasedLines(baseChangelog: string, headChangelog: string): boolean {
  const baseLines = new Set(
    unreleasedSection(baseChangelog)
      .lines.map((line) => line.trim())
      .filter((line) => line !== ""),
  );
  return unreleasedSection(headChangelog).lines.some((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !baseLines.has(trimmed);
  });
}

function isReleasePromotion(base: ReleaseSnapshot, head: ReleaseSnapshot): boolean {
  const released = dropNextSuffix(base.version);
  if (released === undefined || head.version !== released) return false;
  return (
    hasVersionHeading(head.changelog, released) && !hasVersionHeading(base.changelog, released)
  );
}

/**
 * A published bare version moving to another bare version, with notes under the new heading.
 *
 * `0.1.0` to `0.1.1` with `## v0.1.1` is a release. A `-next.N` base is not:
 * that promotion is {@link isReleasePromotion}, and a jump that skips the
 * suffix drop stays a failure.
 *
 * @param base - Version and changelog on the base branch
 * @param head - Version and changelog on the pull request
 * @returns Whether Unreleased may be empty
 */
function isBareReleaseCut(base: ReleaseSnapshot, head: ReleaseSnapshot): boolean {
  if (!isBareVersion(base.version) || !isBareVersion(head.version)) return false;
  if (head.version === base.version) return false;
  if (hasVersionHeading(base.changelog, head.version)) return false;
  if (!hasVersionHeading(head.changelog, head.version)) return false;
  return sectionLines(head.changelog, head.version).some((line) => line.startsWith("-"));
}

/**
 * Notes moved into an existing untagged `## vX.Y.Z` while the package
 * version becomes `X.Y.Z`.
 *
 * `0.7.0-next.4` to `0.6.0`, with new bullets under the `v0.6.0` heading
 * that was already on the base, is a re-cut. The heading has to gain a
 * bullet. A tagged release does not take this path.
 *
 * @param base - Version and changelog on the base branch
 * @param head - Version and changelog on the pull request
 * @returns Whether Unreleased may be empty
 */
function isFoldedUntaggedRelease(base: ReleaseSnapshot, head: ReleaseSnapshot): boolean {
  if (!isBareVersion(head.version)) return false;
  if (!hasVersionHeading(base.changelog, head.version)) return false;
  if (!hasVersionHeading(head.changelog, head.version)) return false;
  const previous = new Set(sectionLines(base.changelog, head.version));
  return sectionLines(head.changelog, head.version).some(
    (line) => line.startsWith("-") && !previous.has(line),
  );
}

function isBareVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function dropNextSuffix(version: string): string | undefined {
  const match = /^(\d+\.\d+\.\d+)-next\.\d+$/.exec(version);
  return match?.[1];
}

function hasNewReleaseNotes(base: ReleaseSnapshot, head: ReleaseSnapshot): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(head.version) || head.version !== base.version) return false;
  const baseLines = new Set(sectionLines(base.changelog, head.version));
  return sectionLines(head.changelog, head.version).some((line) => !baseLines.has(line));
}

function sectionLines(changelog: string, version: string): readonly string[] {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## v${escaped}(?:\\s|$)`);
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function hasVersionHeading(changelog: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## v${escaped}(?:\\s|$)`, "m").test(changelog);
}

function gitShow(rev: string, path: string): string {
  const proc = Bun.spawnSync(["git", "show", `${rev}:${path}`], { cwd: repoRoot() });
  if (proc.exitCode !== 0) {
    const detail = proc.stderr.toString().trim();
    throw new Error(`git show ${rev}:${path} failed${detail === "" ? "" : `: ${detail}`}`);
  }
  return proc.stdout.toString();
}

/**
 * Paths the head changes since it forked from `rev`, renames listed on both sides.
 *
 * @param rev - Base git revision
 * @returns Repository-relative paths
 */
function changedFiles(rev: string): readonly string[] {
  const proc = Bun.spawnSync(
    ["git", "diff", "--name-only", "--no-renames", "-z", `${rev}...HEAD`],
    {
      cwd: repoRoot(),
    },
  );
  if (proc.exitCode !== 0) {
    const detail = proc.stderr.toString().trim();
    throw new Error(`git diff ${rev}...HEAD failed${detail === "" ? "" : `: ${detail}`}`);
  }
  return proc.stdout
    .toString()
    .split("\0")
    .filter((file) => file !== "");
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: { base: { type: "string" } },
      args: process.argv.slice(2),
    });
    const baseRev = values.base;
    if (baseRev === undefined || baseRev === "") {
      console.error("[release-check] Usage: bun ./scripts/release-check.ts --base <git-rev>");
      process.exit(2);
    }
    const exempt = releaseExemption(changedFiles(baseRev));
    if (exempt !== undefined) {
      console.log(`[release-check] ${exempt}`);
      process.exit(0);
    }
    const root = repoRoot();
    const head = readReleaseSnapshot(root);
    const base: ReleaseSnapshot = {
      version: readVersion(gitShow(baseRev, "package.json"), `${baseRev}:package.json`),
      changelog: gitShow(baseRev, "changelog.md"),
    };
    const tag = Bun.spawnSync(["git", "tag", "-l", `v${head.version}`], { cwd: root });
    if (tag.exitCode !== 0) {
      throw new Error(`git tag -l v${head.version} failed`);
    }
    exitOnProblems(
      checkReleaseSnapshots(base, head, { untaggedRelease: tag.stdout.toString().trim() === "" }),
    );
  } catch (error) {
    console.error("[release-check]", error instanceof Error ? error.message : error);
    process.exit(2);
  }
}
