#!/usr/bin/env bun
/**
 * Moves the root `okmodel` package version.
 *
 * - `next` sets `<next minor>-next.N` and does not touch the changelog.
 * - `release` drops a `-next.N` suffix and promotes `## Unreleased`.
 * - `patch`, `minor`, `major`, and `--set` still promote `## Unreleased`.
 *
 * Does not touch git, tags, or workspace packages under `packages/*`.
 *
 * Usage:
 *   bun run scripts/bump-version.ts [patch|minor|major|next|release] [--dry-run]
 *   bun run scripts/bump-version.ts --set X.Y.Z [--dry-run]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const REPO_ROOT = join(import.meta.dir, "..");
const PACKAGE_PATH = join(REPO_ROOT, "package.json");
const CHANGELOG_PATH = join(REPO_ROOT, "changelog.md");

/** Semver bump kind, including the pre-release and release flows. */
export type BumpKind = "patch" | "minor" | "major" | "next" | "release";

/** What a bump will write. `next` leaves the changelog alone. */
export type BumpPlan = {
  readonly version: string;
  readonly promoteChangelog: boolean;
};

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-next\.(\d+))?$/;

type ParsedVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly next: number | undefined;
};

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
  const kind = isBumpKind(kindRaw) ? kindRaw : undefined;
  if (kindRaw !== undefined && kind === undefined) {
    throw new Error(
      `Unknown bump kind '${kindRaw}'. Expected patch, minor, major, next, or release.`,
    );
  }
  return {
    kind,
    set: values.set,
    dryRun: values["dry-run"] ?? false,
  };
}

function isBumpKind(value: string | undefined): value is BumpKind {
  return (
    value === "patch" ||
    value === "minor" ||
    value === "major" ||
    value === "next" ||
    value === "release"
  );
}

/**
 * Plans the next version and whether `## Unreleased` is promoted.
 *
 * @param current - Current package version (`X.Y.Z` or `X.Y.Z-next.N`)
 * @param request - A bump kind or an explicit `--set` version
 * @returns The version to write and whether the changelog is promoted
 */
export function planBump(
  current: string,
  request: { readonly kind?: BumpKind; readonly set?: string },
): BumpPlan {
  if (request.set !== undefined && request.kind !== undefined) {
    throw new Error("Pass either a bump kind or --set, not both.");
  }
  if (request.set !== undefined) {
    return { version: parseSetVersion(request.set), promoteChangelog: true };
  }
  if (request.kind === undefined) {
    throw new Error("Pass a bump kind or --set.");
  }
  if (request.kind === "next") {
    return { version: nextVersion(current), promoteChangelog: false };
  }
  if (request.kind === "release") {
    return { version: releaseVersion(current), promoteChangelog: true };
  }
  return { version: bumpRelease(current, request.kind), promoteChangelog: true };
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
 * Parses `X.Y.Z` or `X.Y.Z-next.N`.
 *
 * @param version - Version string, optional leading `v`
 * @returns The numeric parts and the pre-release counter when present
 */
function parseVersion(version: string): ParsedVersion {
  const match = VERSION_PATTERN.exec(version.trim().replace(/^v/, ""));
  if (match === null) {
    throw new Error(`Invalid version '${version}'. Expected X.Y.Z or X.Y.Z-next.N.`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    next: match[4] === undefined ? undefined : Number(match[4]),
  };
}

/**
 * Accepts an explicit `--set` version. Pre-release numbers use `next` instead.
 *
 * @param version - Bare `X.Y.Z`, optional leading `v`
 * @returns The version without a leading `v`
 */
function parseSetVersion(version: string): string {
  const parsed = parseVersion(version);
  if (parsed.next !== undefined) {
    throw new Error(`--set expects X.Y.Z, got '${version.trim()}'.`);
  }
  return formatBare(parsed);
}

/**
 * Moves to `<next minor>-next.1`, or increments `N` when already on `-next.N`.
 *
 * `0.0.0` becomes `0.1.0-next.1`. `0.1.0-next.1` becomes `0.1.0-next.2`.
 * A released `0.1.0` becomes `0.2.0-next.1`.
 *
 * @param current - Current package version
 * @returns The next pre-release version
 */
function nextVersion(current: string): string {
  const parsed = parseVersion(current);
  if (parsed.next !== undefined) {
    return `${formatBare(parsed)}-next.${parsed.next + 1}`;
  }
  return `${parsed.major}.${parsed.minor + 1}.0-next.1`;
}

/**
 * Drops a `-next.N` suffix, leaving the release version.
 *
 * @param current - A version of the form `X.Y.Z-next.N`
 * @returns The bare release version
 */
function releaseVersion(current: string): string {
  const parsed = parseVersion(current);
  if (parsed.next === undefined) {
    throw new Error(`release expects an X.Y.Z-next.N version, got '${current}'.`);
  }
  return formatBare(parsed);
}

/**
 * Applies patch, minor, or major to the bare version, dropping any `-next` suffix.
 *
 * @param current - Current package version
 * @param kind - patch, minor, or major
 * @returns The next bare version
 */
function bumpRelease(current: string, kind: "patch" | "minor" | "major"): string {
  const parsed = parseVersion(current);
  switch (kind) {
    case "patch":
      return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
    case "minor":
      return `${parsed.major}.${parsed.minor + 1}.0`;
    case "major":
      return `${parsed.major + 1}.0.0`;
  }
}

function formatBare(parsed: ParsedVersion): string {
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

/**
 * Reads the root package version.
 *
 * @returns Current version string
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
      "[bump] Usage: bun run scripts/bump-version.ts [patch|minor|major|next|release] [--dry-run]\n" +
        "       bun run scripts/bump-version.ts --set X.Y.Z [--dry-run]",
    );
    process.exit(2);
  }

  const current = readRootVersion();
  const plan = planBump(current, {
    ...(flags.kind !== undefined ? { kind: flags.kind } : {}),
    ...(flags.set !== undefined ? { set: flags.set } : {}),
  });

  setManifestVersion(PACKAGE_PATH, plan.version, flags.dryRun);
  if (plan.promoteChangelog) applyChangelog(plan.version, flags.dryRun);

  const prefix = flags.dryRun ? "Would bump" : "Bumped";
  console.error(`[bump] ${prefix}: ${current} → ${plan.version}`);
  console.error(`[bump]   ${PACKAGE_PATH}`);
  if (plan.promoteChangelog) console.error(`[bump]   ${CHANGELOG_PATH}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("[bump]", error);
    process.exit(2);
  });
}
