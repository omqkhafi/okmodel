/**
 * Changelog notes from merged pull request titles.
 */

import { expect, test } from "bun:test";

import {
  changelogFromCommits,
  insertUnreleasedNotes,
  type CommitNote,
} from "./changelog-from-commits.js";

function commit(subject: string, body = ""): CommitNote {
  return { subject, body };
}

test("types land in Added, Changed, Fixed, and Security", () => {
  const notes = changelogFromCommits([
    commit("feat(runtime): route reads to a replica"),
    commit("fix(ci): settle a cancelled gate"),
    commit("perf(adapters): skip a copy on the hot path"),
    commit("refactor(tooling): fold two helpers"),
    commit("security(runtime): refuse a cross-tenant token"),
    commit("docs(readme): fix a link"),
    commit("test(ci): cover the gate"),
    commit("chore(deps): bump the npm group"),
  ]);
  expect(notes).toContain("### ✨ Added");
  expect(notes).toContain("- Route reads to a replica.");
  expect(notes).toContain("### 🐛 Fixed");
  expect(notes).toContain("- Settle a cancelled gate.");
  expect(notes).toContain("### ♻️ Changed");
  expect(notes).toContain("- Skip a copy on the hot path.");
  expect(notes).toContain("- Fold two helpers.");
  expect(notes).toContain("### 🔒 Security");
  expect(notes).toContain("- Refuse a cross-tenant token.");
  expect(notes).not.toContain("fix a link");
  expect(notes).not.toContain("Cover the gate");
  expect(notes).not.toContain("npm group");
});

test("a bang or a BREAKING CHANGE line is only a breaking note", () => {
  const notes = changelogFromCommits([
    commit("feat(runtime)!: drop the old connect option"),
    commit("fix(runtime): keep the error kind", "BREAKING CHANGE: the code moved"),
  ]);
  expect(notes).toContain("### 💥 Breaking Changes");
  expect(notes).toContain("- Drop the old connect option.");
  expect(notes).toContain("- Keep the error kind.");
  expect(notes).not.toContain("### ✨ Added");
  expect(notes).not.toContain("### 🐛 Fixed");
});

test("a pull request number on the subject is not part of the note", () => {
  const notes = changelogFromCommits([commit("fix(runtime): close the pool (#433)")]);
  expect(notes).toContain("- Close the pool.");
  expect(notes).not.toContain("#433");
});

test("eight bullets in one group gain area headings", () => {
  const commits = Array.from({ length: 8 }, (_, index) =>
    commit(`feat(runtime): add path ${String(index)}`),
  );
  const notes = changelogFromCommits(commits);
  expect(notes).toContain("#### runtime");
  expect(notes).toContain("- Add path 0.");
  expect(notes).toContain("- Add path 7.");
});

test("insertUnreleasedNotes fills an empty Unreleased section", () => {
  const raw = "# Changelog\n\n## Unreleased\n\n## v0.1.0 — 2026-01-01\n\n- Old.\n";
  const out = insertUnreleasedNotes(raw, "### 🐛 Fixed\n\n- Close the pool.\n");
  expect(out).toContain("## Unreleased\n\n### 🐛 Fixed\n\n- Close the pool.\n\n## v0.1.0");
});
