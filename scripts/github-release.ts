/**
 * Creates the GitHub Release for this version from the changelog section.
 *
 * The notes are the body of `## v` plus `package.json` version. The tag is
 * the same string. The workflow runs this after the npm smoke passes.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./root.js";

/**
 * The body of `## v<version>` in a changelog, without the heading.
 *
 * @param changelog - Full `changelog.md` text
 * @param version - Package version, such as `0.1.1`
 * @returns The section body, ending in a newline
 */
export function changelogReleaseNotes(changelog: string, version: string): string {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const heading = new RegExp(`^## v${escapeRegExp(version)}(?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) throw new Error(`changelog.md has no ## v${version} section`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  if (body.length === 0) throw new Error(`changelog.md ## v${version} section is empty`);
  return `${body}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

if (import.meta.main) {
  const root = repoRoot();
  const version = readVersion(root);
  const notes = changelogReleaseNotes(readFileSync(join(root, "changelog.md"), "utf8"), version);
  const tag = `v${version}`;
  const notesPath = join(root, `.github-release-${version}.md`);
  writeFileSync(notesPath, notes);
  try {
    const proc = Bun.spawn(
      ["gh", "release", "create", tag, "--title", tag, "--notes-file", notesPath],
      { cwd: root, stdout: "inherit", stderr: "inherit" },
    );
    const code = await proc.exited;
    if (code === null || code !== 0) {
      throw new Error(`gh release create ${tag} exited ${String(code)}`);
    }
  } finally {
    rmSync(notesPath, { force: true });
  }
}
