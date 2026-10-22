/**
 * Builds changelog notes from merged pull request titles.
 *
 * Squash merges keep the pull request title as the commit subject. A release
 * reads those subjects since the last `vX.Y.Z` tag. `bump next` does not call
 * this: a prerelease publish only moves the version.
 *
 *   bun ./scripts/changelog-from-commits.ts
 */

import { repoRoot } from "./root.js";

/** One commit on the release range. */
export type CommitNote = {
  /** First line, the pull request title for a squash merge. */
  readonly subject: string;
  /** Rest of the message. A `BREAKING CHANGE:` line marks the note. */
  readonly body: string;
};

/** Changelog areas, in the order a large group prints them. */
export const CHANGELOG_AREAS = [
  "contracts",
  "dialects",
  "adapters",
  "runtime",
  "tooling",
  "docs",
] as const;

const TYPES = "feat|fix|perf|docs|test|chore|refactor|security";

const SUBJECT = new RegExp(
  `^(${TYPES})(?:\\(([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\\))?(!)?:\\s+(\\S.*?)(?:\\s+\\(#\\d+\\))?$`,
);

const GROUP_HEADINGS = [
  ["breaking", "### 💥 Breaking Changes"],
  ["added", "### ✨ Added"],
  ["changed", "### ♻️ Changed"],
  ["fixed", "### 🐛 Fixed"],
  ["security", "### 🔒 Security"],
] as const;

type GroupKey = (typeof GROUP_HEADINGS)[number][0];

type Note = {
  readonly group: GroupKey;
  readonly area: (typeof CHANGELOG_AREAS)[number] | "tooling";
  readonly text: string;
};

/**
 * Turns conventional commit subjects into changelog groups.
 *
 * `feat` is Added, `fix` is Fixed, `perf` and `refactor` are Changed, and
 * `security` is Security. `docs`, `test`, and `chore` are omitted. A `!`
 * before the colon, or a `BREAKING CHANGE:` line in the body, is Breaking
 * Changes and is not repeated in the type group. A group with eight or more
 * bullets gains `####` area headings.
 *
 * @param commits - Subjects and bodies, oldest first
 * @returns Markdown for `## Unreleased`, or an empty string when nothing qualifies
 */
export function changelogFromCommits(commits: readonly CommitNote[]): string {
  const notes: Note[] = [];
  for (const commit of commits) {
    const note = noteFromCommit(commit);
    if (note !== undefined) notes.push(note);
  }
  const blocks: string[] = [];
  for (const [key, heading] of GROUP_HEADINGS) {
    const group = notes.filter((note) => note.group === key);
    if (group.length === 0) continue;
    blocks.push(renderGroup(heading, group));
  }
  return blocks.join("\n");
}

/**
 * Inserts generated notes into an empty `## Unreleased` section.
 *
 * @param raw - Full changelog text
 * @param notes - Markdown from {@link changelogFromCommits}, without a `##` heading
 * @returns The changelog with those notes under Unreleased
 */
export function insertUnreleasedNotes(raw: string, notes: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^## Unreleased\s*$/.test(line));
  if (start === -1) throw new Error("changelog.md has no ## Unreleased section");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start + 1);
  const after = lines.slice(end);
  const body = notes.trim();
  return [...before, "", body, "", ...after].join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * The newest bare `vX.Y.Z` tag, ignoring prerelease tags.
 *
 * @param root - Repository root
 * @returns The tag, or undefined when none exists
 */
export function lastReleaseTag(root: string): string | undefined {
  const proc = Bun.spawnSync(["git", "tag", "--list", "v*", "--sort=-v:refname"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return undefined;
  for (const line of proc.stdout.toString().split("\n")) {
    const tag = line.trim();
    if (/^v\d+\.\d+\.\d+$/.test(tag)) return tag;
  }
  return undefined;
}

/**
 * Commit subjects and bodies after `rev`, oldest first.
 *
 * @param root - Repository root
 * @param rev - Exclusive start, usually the last release tag
 * @returns One entry per commit
 */
export function readCommitsSince(root: string, rev: string): readonly CommitNote[] {
  const proc = Bun.spawnSync(
    ["git", "log", "--reverse", `${rev}..HEAD`, "--pretty=format:%s%x1e%b%x1f"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    const detail = proc.stderr.toString().trim();
    throw new Error(`git log ${rev}..HEAD failed${detail === "" ? "" : `: ${detail}`}`);
  }
  const notes: CommitNote[] = [];
  for (const record of proc.stdout.toString().split("\x1f")) {
    if (record.trim() === "") continue;
    const split = record.indexOf("\x1e");
    if (split === -1) {
      notes.push({ subject: record.trim(), body: "" });
      continue;
    }
    notes.push({
      subject: record.slice(0, split).trim(),
      body: record.slice(split + 1).trim(),
    });
  }
  return notes;
}

/**
 * Notes for `## Unreleased` from commits after the last bare release tag.
 *
 * @param root - Repository root
 * @returns Generated markdown, or an empty string when there is no tag or no qualifying commit
 */
export function notesSinceLastRelease(root: string): string {
  const tag = lastReleaseTag(root);
  if (tag === undefined) return "";
  return changelogFromCommits(readCommitsSince(root, tag));
}

function noteFromCommit(commit: CommitNote): Note | undefined {
  const match = SUBJECT.exec(commit.subject.trim());
  if (match === null) return undefined;
  const type = match[1];
  const scope = match[2];
  const bang = match[3];
  const summary = match[4];
  if (type === undefined || summary === undefined) return undefined;
  const breaking = bang === "!" || /^BREAKING CHANGE:/m.test(commit.body);
  if (!breaking && (type === "docs" || type === "test" || type === "chore")) return undefined;
  const group: GroupKey = breaking
    ? "breaking"
    : type === "feat"
      ? "added"
      : type === "fix"
        ? "fixed"
        : type === "security"
          ? "security"
          : "changed";
  return {
    group,
    area: areaForScope(scope),
    text: sentence(summary),
  };
}

function areaForScope(scope: string | undefined): Note["area"] {
  if (scope === "ci") return "tooling";
  if (scope !== undefined && (CHANGELOG_AREAS as readonly string[]).includes(scope)) {
    return scope as Note["area"];
  }
  return "tooling";
}

function sentence(summary: string): string {
  const trimmed = summary.trim();
  const cased = trimmed.length === 0 ? trimmed : `${trimmed[0]!.toUpperCase()}${trimmed.slice(1)}`;
  return /[.!?]$/.test(cased) ? cased : `${cased}.`;
}

function renderGroup(heading: string, notes: readonly Note[]): string {
  if (notes.length < 8) {
    return `${heading}\n\n${notes.map((note) => `- ${note.text}`).join("\n")}\n`;
  }
  const blocks = [heading, ""];
  for (const area of CHANGELOG_AREAS) {
    const rows = notes.filter((note) => note.area === area);
    if (rows.length === 0) continue;
    blocks.push(`#### ${area}`, "", ...rows.map((note) => `- ${note.text}`), "");
  }
  return `${blocks.join("\n").trimEnd()}\n`;
}

if (import.meta.main) {
  const notes = notesSinceLastRelease(repoRoot());
  process.stdout.write(notes.length === 0 ? "" : `${notes.trimEnd()}\n`);
}
