/**
 * Fails a pull request whose package version matches the base branch, or whose
 * changelog has no new lines under `## Unreleased`.
 *
 * A release that drops a `-next.N` suffix and promotes Unreleased into
 * `## vX.Y.Z` is allowed to leave Unreleased empty.
 *
 * Usage:
 *   bun ./scripts/release-check.ts --base <git-rev>
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

/** Package version and changelog text for one side of a pull request. */
export type ReleaseSnapshot = {
  readonly version: string;
  readonly changelog: string;
};

/**
 * Compares a head snapshot with its base.
 *
 * @param base - Version and changelog on the base branch
 * @param head - Version and changelog on the pull request
 * @returns Problem lines. Empty when the pull request moves the version and the notes
 */
export function checkReleaseSnapshots(
  base: ReleaseSnapshot,
  head: ReleaseSnapshot,
): readonly string[] {
  const problems: string[] = [];
  if (head.version === base.version) {
    problems.push(`package.json version ${head.version} equals the base branch`);
  }
  const headSection = unreleasedSection(head.changelog);
  if (!headSection.found) {
    problems.push("changelog.md has no ## Unreleased section");
    return problems;
  }
  if (!hasNewUnreleasedLines(base.changelog, head.changelog) && !isReleasePromotion(base, head)) {
    problems.push("changelog.md has no new lines under ## Unreleased");
  }
  return problems;
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

function dropNextSuffix(version: string): string | undefined {
  const match = /^(\d+\.\d+\.\d+)-next\.\d+$/.exec(version);
  return match?.[1];
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
    const root = repoRoot();
    const base: ReleaseSnapshot = {
      version: readVersion(gitShow(baseRev, "package.json"), `${baseRev}:package.json`),
      changelog: gitShow(baseRev, "changelog.md"),
    };
    exitOnProblems(checkReleaseSnapshots(base, readReleaseSnapshot(root)));
  } catch (error) {
    console.error("[release-check]", error instanceof Error ? error.message : error);
    process.exit(2);
  }
}
