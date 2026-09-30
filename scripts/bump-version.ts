#!/usr/bin/env bun
/**
 * Bumps the root `okmodel` package version and promotes `## Unreleased`
 * in `changelog.md` into `## v<new> — <today>`.
 *
 * Does not touch git, tags, or workspace packages under `packages/*`.
 *
 * Usage:
 *   bun run scripts/bump-version.ts [patch|minor|major] [--dry-run]
 *   bun run scripts/bump-version.ts --set 0.1.0 [--dry-run]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const REPO_ROOT = join(import.meta.dir, "..");
const PACKAGE_PATH = join(REPO_ROOT, "package.json");
const CHANGELOG_PATH = join(REPO_ROOT, "changelog.md");

/** Semver bump kind. */
type BumpKind = "patch" | "minor" | "major";

/**
 * Parses CLI flags for the bump script.
 *
 * @returns The bump kind, an explicit version, and whether this is a dry run
 */
function parseFlags(): {
  kind: BumpKind | undefined;
  set: string | undefined;
  dryRun: boolean;
} {
  const { values, positionals } = parseArgs({
    options: {
      set: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: true,
    args: process.argv.slice(2),
  });
  const kindRaw = positionals[0];
  const kind =
    kindRaw === "patch" || kindRaw === "minor" || kindRaw === "major" ? kindRaw : undefined;
  return {
    kind,
    set: values.set,
    dryRun: values["dry-run"] ?? false,
  };
}

/**
 * Replaces the top-level `"version"` string in a JSON manifest in place.
 *
 * @param path - Absolute path to package.json
 * @param version - New semver string
 * @param dryRun - When true, do not write
 */
function setManifestVersion(path: string, version: string, dryRun: boolean): void {
  const raw = readFileSync(path, "utf-8");
  const next = raw.replace(/("version"\s*:\s*")([^"]*)(")/, `$1${version}$3`);
  if (next === raw) {
    throw new Error(`${path} has no "version" string field to replace.`);
  }
  const parsed = JSON.parse(next) as { version?: unknown };
  if (parsed.version !== version) {
    throw new Error(`${path}: version rewrite failed (got ${String(parsed.version)}).`);
  }
  if (!dryRun) writeFileSync(path, next, "utf-8");
}

/**
 * Parses `X.Y.Z` into numeric parts.
 *
 * @param version - Semver string
 * @returns Major, minor, and patch
 */
function parseSemver(version: string): [number, number, number] {
  const parts = version.trim().replace(/^v/, "").split(".");
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error(`Invalid version '${version}'. Expected X.Y.Z.`);
  }
  return [
    Number.parseInt(parts[0] ?? "", 10),
    Number.parseInt(parts[1] ?? "", 10),
    Number.parseInt(parts[2] ?? "", 10),
  ];
}

/**
 * Applies a bump kind to a version string.
 *
 * @param version - Current version
 * @param kind - patch, minor, or major
 * @returns The next version
 */
function bump(version: string, kind: BumpKind): string {
  const [major, minor, patch] = parseSemver(version);
  switch (kind) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
  }
}

/**
 * Resolves the next version from an explicit `--set` or a bump kind.
 *
 * @param current - Current package version
 * @param set - Explicit version from `--set`, when present
 * @param kind - Bump kind, when `--set` is absent
 * @returns The next bare version
 */
function resolveNextVersion(
  current: string,
  set: string | undefined,
  kind: BumpKind | undefined,
): string {
  if (set !== undefined) {
    parseSemver(set);
    return set.replace(/^v/, "");
  }
  if (kind === undefined) {
    throw new Error("Pass a bump kind or --set.");
  }
  return bump(current, kind);
}

/**
 * Reads the root package version.
 *
 * @returns Current `X.Y.Z` version
 */
function readRootVersion(): string {
  const pkg = JSON.parse(readFileSync(PACKAGE_PATH, "utf-8")) as { version?: unknown };
  if (typeof pkg.version !== "string") {
    throw new Error(`${PACKAGE_PATH} has no string "version" field.`);
  }
  return pkg.version;
}

/** Local calendar date as `YYYY-MM-DD`. */
function todayLocal(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Promotes `## Unreleased` into `## v{version} — {date}`, leaving a fresh
 * empty Unreleased section for the next cycle.
 *
 * @param raw - Full changelog.md text
 * @param version - Bare next version (no `v`)
 * @param date - ISO date for the new heading
 * @returns Updated changelog text
 */
export function promoteUnreleasedSection(raw: string, version: string, date: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^## Unreleased\s*$/.test(line)) {
      start = i;
      continue;
    }
    if (start !== -1 && end === -1 && /^##\s+/.test(line)) {
      end = i;
      break;
    }
  }
  if (start === -1) {
    throw new Error(
      "changelog.md has no ## Unreleased section — okm-ship writes upcoming notes there; bump promotes them.",
    );
  }
  if (end === -1) end = lines.length;

  const body = lines.slice(start + 1, end);
  while (body.length > 0 && body[0]?.trim() === "") body.shift();
  while (body.length > 0 && body[body.length - 1]?.trim() === "") body.pop();

  if (!body.some((line) => /^-\s+/.test(line.trim()))) {
    throw new Error("## Unreleased has no bullets — add ship notes with okm-ship before bumping.");
  }

  const before = lines.slice(0, start);
  const after = lines.slice(end);
  const rest = after[0]?.trim() === "" ? after.slice(1) : after;

  return [...before, "## Unreleased", "", `## v${version} — ${date}`, "", ...body, "", ...rest]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Promotes Unreleased in the on-disk changelog.
 *
 * @param version - Next bare version
 * @param dryRun - When true, do not write
 * @returns The changelog path
 */
function applyChangelog(version: string, dryRun: boolean): string {
  const raw = readFileSync(CHANGELOG_PATH, "utf-8");
  try {
    const next = promoteUnreleasedSection(raw, version, todayLocal());
    if (!dryRun) writeFileSync(CHANGELOG_PATH, next.endsWith("\n") ? next : `${next}\n`, "utf-8");
  } catch (error) {
    if (!dryRun) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bump]   note: ${message}`);
  }
  return CHANGELOG_PATH;
}

/**
 * Runs the bump.
 */
async function main(): Promise<void> {
  const flags = parseFlags();
  if (!flags.set && !flags.kind) {
    console.error(
      "[bump] Usage: bun run scripts/bump-version.ts [patch|minor|major] [--dry-run]\n" +
        "       bun run scripts/bump-version.ts --set X.Y.Z [--dry-run]",
    );
    process.exit(2);
  }
  if (flags.set && flags.kind) {
    console.error("[bump] Pass either a bump kind or --set, not both.");
    process.exit(2);
  }

  const current = readRootVersion();
  const next = resolveNextVersion(current, flags.set, flags.kind);

  setManifestVersion(PACKAGE_PATH, next, flags.dryRun);
  applyChangelog(next, flags.dryRun);

  const prefix = flags.dryRun ? "Would bump" : "Bumped";
  console.error(`[bump] ${prefix}: ${current} → ${next}`);
  console.error(`[bump]   ${PACKAGE_PATH}`);
  console.error(`[bump]   ${CHANGELOG_PATH}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("[bump]", error);
    process.exit(2);
  });
}
