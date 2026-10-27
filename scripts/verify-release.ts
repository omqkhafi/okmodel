/**
 * Checks a published npm tarball against the record from the release pack.
 *
 * The release workflow packs once, writes this record (sha256 and file
 * list), publishes that tarball, and passes it with `--recorded`. The
 * registry copy must match that record. The tarball's `package.json`
 * version must be the requested version, and its file list must match the
 * pack-contract snapshot on the tag. Provenance is `npm audit signatures`,
 * which verifies the registry attestation. `npm view --json` shows the
 * predicate type and does not verify the signature.
 *
 * A hand run without `--recorded` still checks the version, the snapshot,
 * and the attestation. It also packs the tag and prints whether that
 * rebuild matches the published tarball. That line is a warning. A rebuild
 * is not a gate: the pack is not byte-stable across machines, and this
 * repository does not claim reproducible builds.
 *
 * Tag `v0.9.1` is not an ancestor of `origin/main`. That known fact is a
 * warning. Any other tag off main fails the run.
 *
 *   bun ./scripts/verify-release.ts 0.10.0 --recorded release-record.json
 *   bun ./scripts/verify-release.ts --write-record okmodel.tgz release-record.json
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_SNAPSHOT, packedFileDiff } from "./pack-contract.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

/** npm package this repository publishes. */
const PACKAGE_NAME = "okmodel";

/**
 * Versions whose tag is known to sit off `main`.
 *
 * The ancestry check warns for these and fails for every other tag.
 */
export const KNOWN_OFF_MAIN_VERSIONS = ["0.9.1"] as const;

/** Command that verifies the published provenance attestation. */
export const ATTESTATION_CHECK = "npm audit signatures";

/** `package.json` version this script accepts, including a prerelease. */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Lowercase hex sha256 of a tarball.
 *
 * @param bytes - Tarball bytes
 * @returns Hex digest
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** sha256 and file list of the one tarball the release job packed. */
export type ReleaseRecord = {
  /** Lowercase hex sha256 of the tarball bytes. */
  readonly sha256: string;
  /** Packed paths, without the `package/` prefix, sorted. */
  readonly files: readonly string[];
};

/** Printed lines and the lines that fail a recorded-tarball check. */
export type RecordedAssessment = {
  /** Report lines, including the failures. */
  readonly lines: readonly string[];
  /** Failures. Empty when the tarball matches the record and the version. */
  readonly problems: readonly string[];
};

/**
 * Warning for a hand-run rebuild of the tag.
 *
 * A match and a mismatch both warn. Neither is a failure.
 *
 * @param published - Bytes downloaded from the registry
 * @param packed - Bytes from a pack of the tag on this machine
 * @returns The warning line
 */
export function rebuildWarning(published: Uint8Array, packed: Uint8Array): string {
  const left = sha256Hex(published);
  const right = sha256Hex(packed);
  if (left === right) {
    return `warning: rebuild sha256 ${left} matches the published tarball (not a gate)`;
  }
  return `warning: rebuild sha256 ${right} does not match the published tarball ${left} (not a gate)`;
}

/**
 * Why the registry tarball is not the recorded one.
 *
 * A missing sha256 fails before the file list. A sha256 match with a
 * different file list still fails.
 *
 * @param published - Bytes downloaded from the registry
 * @param version - Version the command was asked to verify
 * @param record - Parsed release record. A missing sha256 is a failure
 * @returns Report lines and problems
 */
export async function assessRecorded(
  published: Uint8Array,
  version: string,
  record: unknown,
): Promise<RecordedAssessment> {
  const lines: string[] = [];
  const problems: string[] = [];
  const actual = sha256Hex(published);
  const recordedSha = recordedSha256(record);
  if (recordedSha === undefined) {
    const problem = "recorded tarball has no sha256";
    problems.push(problem);
    lines.push(problem);
  } else if (recordedSha !== actual) {
    const problem = `sha256 ${actual} does not match the recorded tarball (${recordedSha})`;
    problems.push(problem);
    lines.push(problem);
  } else lines.push(`sha256 ${actual} matches the recorded tarball`);

  let listing: string;
  let manifestText: string;
  try {
    listing = await tarballListing(published);
    manifestText = await tarballText(published, "package/package.json");
  } catch (error) {
    if (recordedSha !== actual) return { lines, problems };
    const message = error instanceof Error ? error.message : String(error);
    problems.push(message);
    lines.push(message);
    return { lines, problems };
  }

  const recordedFiles = recordedFilesOf(record);
  if (recordedFiles === undefined) {
    const problem = "recorded tarball has no file list";
    problems.push(problem);
    lines.push(problem);
  } else {
    const diff = recordedFileListProblem(packedEntryPaths(listing), recordedFiles);
    if (diff !== undefined) {
      problems.push(diff);
      lines.push(diff);
    } else lines.push("file list matches the recorded tarball");
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText) as unknown;
  } catch {
    const problem = "package.json in the tarball is not JSON";
    problems.push(problem);
    lines.push(problem);
    return { lines, problems };
  }
  const versionLine = versionProblem(version, manifest);
  if (versionLine !== undefined) {
    problems.push(versionLine);
    lines.push(versionLine);
  } else lines.push(`package.json version ${version}`);
  return { lines, problems };
}

/**
 * Why a file list is not the recorded list.
 *
 * Chunk hashes are normalized before the compare. {@link packedFileDiff}
 * runs each path through `normalizePackedPath`, which replaces a content-hash
 * chunk basename with `*`, then compares the count of each normalized name.
 * Two lists with the same files and different chunk hashes match.
 *
 * @param actual - Paths in the tarball, without the `package/` prefix
 * @param recorded - Paths in the release record
 * @returns The problem, or undefined when the lists match
 */
export function recordedFileListProblem(
  actual: readonly string[],
  recorded: readonly string[],
): string | undefined {
  const diff = packedFileDiff(actual, recorded);
  if (diff.extra.length === 0 && diff.missing.length === 0) return undefined;
  const lines = ["file list differs from the recorded tarball"];
  for (const path of diff.extra) lines.push(`  + ${path}`);
  for (const path of diff.missing) lines.push(`  - ${path}`);
  return lines.join("\n");
}

/**
 * Writes the sha256 and file list of one packed tarball.
 *
 * @param tarballPath - Path to the `.tgz` the release job will publish
 * @param outPath - Where to write the JSON record
 * @returns The record that was written
 */
export async function writeReleaseRecord(
  tarballPath: string,
  outPath: string,
): Promise<ReleaseRecord> {
  const bytes = new Uint8Array(readFileSync(tarballPath));
  const record: ReleaseRecord = {
    sha256: sha256Hex(bytes),
    files: packedEntryPaths(await tarballListing(bytes)),
  };
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * Why a manifest version is not the requested version.
 *
 * @param version - Version the command was asked to verify
 * @param manifest - Parsed `package.json` from the tarball
 * @returns The problem, or undefined when the field equals `version`
 */
export function versionProblem(version: string, manifest: unknown): string | undefined {
  if (isRecord(manifest) && manifest.version === version) return undefined;
  const actual = isRecord(manifest) ? manifest.version : undefined;
  const shown = typeof actual === "string" && actual.length > 0 ? actual : "(missing)";
  return `package.json version is ${shown}, expected ${version}`;
}

/**
 * Why a tarball file list is not the pack-contract snapshot.
 *
 * @param tag - Tag whose snapshot was read
 * @param actual - Paths in the tarball, without the `package/` prefix
 * @param expected - Paths in the snapshot
 * @returns The problem, or undefined when the lists match
 */
export function fileListProblem(
  tag: string,
  actual: readonly string[],
  expected: readonly string[],
): string | undefined {
  const diff = packedFileDiff(actual, expected);
  if (diff.extra.length === 0 && diff.missing.length === 0) return undefined;
  const lines = [`file list differs from the pack-contract snapshot on ${tag}`];
  for (const path of diff.extra) lines.push(`  + ${path}`);
  for (const path of diff.missing) lines.push(`  - ${path}`);
  return lines.join("\n");
}

/**
 * Why a tag that is not on main fails the check.
 *
 * {@link KNOWN_OFF_MAIN_VERSIONS} are warnings from {@link ancestryWarning}.
 *
 * @param version - Requested version
 * @param onMain - Whether the tag commit is an ancestor of `origin/main`
 * @returns The problem, or undefined when the tag is on main or is a known exception
 */
export function ancestryProblem(version: string, onMain: boolean): string | undefined {
  if (onMain) return undefined;
  if (isKnownOffMain(version)) return undefined;
  return `tag v${version} is not on main`;
}

/**
 * Warning for a known tag that is not on main.
 *
 * @param version - Requested version
 * @param onMain - Whether the tag commit is an ancestor of `origin/main`
 * @returns The warning, or undefined when there is nothing to warn about
 */
export function ancestryWarning(version: string, onMain: boolean): string | undefined {
  if (onMain || !isKnownOffMain(version)) return undefined;
  return `warning: tag v${version} is not on main (known tag-not-on-main)`;
}

/**
 * Why `npm audit signatures` did not verify the attestation.
 *
 * @param code - Exit code of {@link ATTESTATION_CHECK}
 * @param output - Combined stdout and stderr
 * @returns The problem, or undefined when the command verified an attestation
 */
export function attestationProblem(code: number, output: string): string | undefined {
  if (code === 0 && output.includes("verified attestation")) return undefined;
  const detail = output.trim().split("\n").slice(-12).join("\n");
  const suffix = detail.length > 0 ? `\n${detail}` : "";
  return `provenance: ${ATTESTATION_CHECK} did not verify the attestation${suffix}`;
}

/**
 * File paths inside an npm tarball listing.
 *
 * Directories are dropped. The `package/` prefix npm adds is stripped.
 *
 * @param listing - `tar -tzf` output
 * @returns Sorted relative paths
 */
export function packedEntryPaths(listing: string): readonly string[] {
  const paths: string[] = [];
  for (const line of listing.split("\n")) {
    const entry = line.trim();
    if (entry.length === 0 || entry.endsWith("/")) continue;
    const relative = entry.startsWith("package/") ? entry.slice("package/".length) : entry;
    if (relative.length === 0) continue;
    paths.push(relative);
  }
  return [...paths].sort();
}

/**
 * Sorted `files` from a pack-contract snapshot, or undefined when it is not one.
 *
 * @param parsed - Parsed snapshot JSON
 * @returns The file list, or undefined when the document has no string array
 */
export function snapshotFileList(parsed: unknown): readonly string[] | undefined {
  if (!isRecord(parsed) || !Array.isArray(parsed.files)) return undefined;
  const files: string[] = [];
  for (const file of parsed.files) {
    if (typeof file !== "string" || file.length === 0) return undefined;
    files.push(file);
  }
  return [...files].sort();
}

/**
 * @param version - Candidate version argument
 * @returns Whether `version` is a release or prerelease this script accepts
 */
export function isReleaseVersion(version: string): boolean {
  return VERSION.test(version);
}

const USAGE = "usage: bun ./scripts/verify-release.ts <version> [--recorded <path>]";

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--write-record") {
    const tarball = args[1];
    const out = args[2];
    if (tarball === undefined || out === undefined || args.length !== 3) {
      exitOnProblems(["usage: bun ./scripts/verify-release.ts --write-record <tarball> <out>"]);
    } else {
      const record = await writeReleaseRecord(tarball, out);
      console.log(record.sha256);
    }
  } else {
    const version = args[0];
    if (version === undefined || !isReleaseVersion(version)) {
      exitOnProblems([USAGE]);
    } else {
      const recorded = recordedArg(args.slice(1));
      const report = await verifyRelease(version, recorded);
      console.log(report.lines.join("\n"));
      exitOnProblems(report.problems);
    }
  }
}

/**
 * @param args - Arguments after the version
 * @returns The `--recorded` path, or undefined when the run is by hand
 */
function recordedArg(args: readonly string[]): string | undefined {
  if (args.length === 0) return undefined;
  const path = args[1];
  if (
    args.length === 2 &&
    args[0] === "--recorded" &&
    path !== undefined &&
    !path.startsWith("-")
  ) {
    return path;
  }
  exitOnProblems([USAGE]);
  return undefined;
}

/** Printed report and the lines that make the process exit non-zero. */
type VerifyReport = {
  /** Every line of the report, including warnings. */
  readonly lines: readonly string[];
  /** Failures. Empty when the run passed. */
  readonly problems: readonly string[];
};

/**
 * Verifies one published version and returns the report.
 *
 * @param version - Version argument, already checked with {@link isReleaseVersion}
 * @param recordedPath - Release record. Absent on a hand run, which warns about a rebuild
 * @returns Report lines and problems
 */
async function verifyRelease(
  version: string,
  recordedPath: string | undefined,
): Promise<VerifyReport> {
  const tag = `v${version}`;
  const lines: string[] = [`verify-release ${PACKAGE_NAME}@${version}`];
  const problems: string[] = [];
  const root = repoRoot();

  const fetched = await fetchTag(root, tag);
  if (fetched !== undefined) {
    problems.push(fetched);
    lines.push(fetched);
    return { lines, problems };
  }

  const commit = await git(root, ["rev-parse", `${tag}^{commit}`]);
  if (commit.code !== 0) {
    const problem = `tag ${tag} did not resolve\n${tail(commit.stderr || commit.stdout)}`;
    problems.push(problem);
    lines.push(problem);
    return { lines, problems };
  }
  const ancestor = await git(root, [
    "merge-base",
    "--is-ancestor",
    commit.stdout.trim(),
    "origin/main",
  ]);
  const onMain = ancestor.code === 0;
  const ancestry = ancestryProblem(version, onMain);
  const warning = ancestryWarning(version, onMain);
  if (ancestry !== undefined) {
    problems.push(ancestry);
    lines.push(ancestry);
  } else if (warning !== undefined) lines.push(warning);
  else lines.push(`tag ${tag} is on main`);

  let published: Uint8Array;
  try {
    published = await downloadTarball(version);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const problem = `${PACKAGE_NAME}@${version} is not on the registry\n${message}`;
    problems.push(problem);
    lines.push(problem);
    return { lines, problems };
  }

  if (recordedPath === undefined) {
    try {
      const packed = await packTag(root, tag);
      lines.push(rebuildWarning(published, packed));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(message);
      lines.push(message);
      return { lines, problems };
    }
    const manifestProblem = await manifestVersionProblem(published, version);
    if (manifestProblem !== undefined) {
      problems.push(manifestProblem);
      lines.push(manifestProblem);
    } else lines.push(`package.json version ${version}`);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(recordedPath, "utf8")) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const problem = `could not read the recorded tarball\n${message}`;
      problems.push(problem);
      lines.push(problem);
      return { lines, problems };
    }
    const assessed = await assessRecorded(published, version, parsed);
    lines.push(...assessed.lines);
    problems.push(...assessed.problems);
  }

  const files = await fileListReport(root, tag, published);
  if (files.problem !== undefined) {
    problems.push(files.problem);
    lines.push(files.problem);
  }
  if (files.line !== undefined) lines.push(files.line);

  const attestation = await checkAttestation(version);
  if (attestation.problem !== undefined) {
    problems.push(attestation.problem);
    lines.push(attestation.problem);
  } else if (attestation.line !== undefined) lines.push(attestation.line);

  return { lines, problems };
}

/**
 * @param record - Parsed release record
 * @returns The sha256, or undefined when it is missing or not 64 hex characters
 */
function recordedSha256(record: unknown): string | undefined {
  if (!isRecord(record)) return undefined;
  const sha = record.sha256;
  if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) return undefined;
  return sha;
}

/**
 * @param record - Parsed release record
 * @returns The file list, or undefined when `files` is not an array of strings
 */
function recordedFilesOf(record: unknown): readonly string[] | undefined {
  if (!isRecord(record) || !Array.isArray(record.files)) return undefined;
  const files: string[] = [];
  for (const file of record.files) {
    if (typeof file !== "string") return undefined;
    files.push(file);
  }
  return files;
}

/**
 * @param version - Requested version
 * @returns Whether the off-main tag is the known historical case
 */
function isKnownOffMain(version: string): boolean {
  return (KNOWN_OFF_MAIN_VERSIONS as readonly string[]).includes(version);
}

/**
 * Fetches the tag and `origin/main`.
 *
 * @param root - Repository root
 * @param tag - Tag name, such as `v0.9.1`
 * @returns A problem, or undefined when both refs are present
 */
async function fetchTag(root: string, tag: string): Promise<string | undefined> {
  const tagFetch = await git(root, [
    "fetch",
    "--no-tags",
    "origin",
    `refs/tags/${tag}:refs/tags/${tag}`,
  ]);
  if (tagFetch.code !== 0) {
    return `could not fetch tag ${tag}\n${tail(tagFetch.stderr || tagFetch.stdout)}`;
  }
  const mainFetch = await git(root, ["fetch", "--no-tags", "origin", "main"]);
  if (mainFetch.code !== 0) {
    return `could not fetch origin/main\n${tail(mainFetch.stderr || mainFetch.stdout)}`;
  }
  return undefined;
}

/**
 * Downloads the registry tarball for one version.
 *
 * @param version - Published version
 * @returns Tarball bytes
 */
async function downloadTarball(version: string): Promise<Uint8Array> {
  const viewed = await command(repoRoot(), [
    "npm",
    "view",
    `${PACKAGE_NAME}@${version}`,
    "dist.tarball",
    "--json",
  ]);
  if (viewed.code !== 0) {
    throw new Error(
      tail(viewed.stderr || viewed.stdout) || `npm view exited ${String(viewed.code)}`,
    );
  }
  let url: unknown;
  try {
    url = JSON.parse(viewed.stdout) as unknown;
  } catch {
    throw new Error("npm view did not return JSON");
  }
  if (typeof url !== "string" || !url.startsWith("https://registry.npmjs.org/")) {
    throw new Error("npm view did not return a registry tarball URL");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`GET ${url} returned ${String(response.status)}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Packs a clean `git archive` of `tag`.
 *
 * @param root - Repository root, where the tag is resolved
 * @param tag - Tag name
 * @returns Packed tarball bytes
 */
async function packTag(root: string, tag: string): Promise<Uint8Array> {
  const work = mkdtempSync(join(tmpdir(), "okm-verify-"));
  const archive = join(work, "source.tar");
  const src = join(work, "src");
  try {
    mkdirSync(src);
    const archived = await git(root, ["archive", "--format=tar", "-o", archive, tag]);
    if (archived.code !== 0) {
      throw new Error(`git archive ${tag} failed\n${tail(archived.stderr)}`);
    }
    const extracted = await command(root, ["tar", "-x", "-f", archive, "-C", src]);
    if (extracted.code !== 0) {
      throw new Error(`could not extract ${tag}\n${tail(extracted.stderr)}`);
    }
    const installed = await command(src, ["bun", "install", "--frozen-lockfile"]);
    if (installed.code !== 0) {
      throw new Error(
        `bun install failed for ${tag}\n${tail(installed.stderr || installed.stdout)}`,
      );
    }
    const built = await command(src, ["bun", "run", "build"]);
    if (built.code !== 0) {
      throw new Error(`bun run build failed for ${tag}\n${tail(built.stderr || built.stdout)}`);
    }
    const before = new Set(readdirSync(src).filter((name) => name.endsWith(".tgz")));
    const packed = await command(src, ["bun", "pm", "pack"]);
    if (packed.code !== 0) {
      throw new Error(`bun pm pack failed for ${tag}\n${tail(packed.stderr || packed.stdout)}`);
    }
    const created = readdirSync(src).filter((name) => name.endsWith(".tgz") && !before.has(name));
    const name = created[0];
    if (name === undefined || created.length !== 1) {
      throw new Error(`bun pm pack did not write one tarball for ${tag}`);
    }
    return new Uint8Array(readFileSync(join(src, name)));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * @param published - Downloaded tarball
 * @param version - Requested version
 * @returns The version problem, or undefined when it matches
 */
async function manifestVersionProblem(
  published: Uint8Array,
  version: string,
): Promise<string | undefined> {
  const text = await tarballText(published, "package/package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(text) as unknown;
  } catch {
    return "package.json in the tarball is not JSON";
  }
  return versionProblem(version, manifest);
}

/** File-list outcome: a failure, a warning, or a success line. */
type FileListReport = {
  /** Set when the snapshot exists and the lists differ, or the snapshot is unreadable. */
  readonly problem?: string;
  /** Success or warning line. Absent when `problem` already describes the list. */
  readonly line?: string;
};

/**
 * Compares the tarball to the snapshot committed on the tag.
 *
 * A tag that predates the snapshot warns. A present snapshot that does not
 * match is a failure.
 *
 * @param root - Repository root
 * @param tag - Tag name
 * @param published - Downloaded tarball
 * @returns The problem and the report line
 */
async function fileListReport(
  root: string,
  tag: string,
  published: Uint8Array,
): Promise<FileListReport> {
  const shown = await git(root, ["show", `${tag}:${DEFAULT_SNAPSHOT}`]);
  if (shown.code !== 0) {
    return { line: `warning: tag ${tag} has no pack-contract snapshot` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(shown.stdout) as unknown;
  } catch {
    return { problem: `pack-contract snapshot on ${tag} is not JSON` };
  }
  const expected = snapshotFileList(parsed);
  if (expected === undefined) {
    return { problem: `pack-contract snapshot on ${tag} has no file list` };
  }
  const listing = await tarballListing(published);
  const problem = fileListProblem(tag, packedEntryPaths(listing), expected);
  if (problem !== undefined) return { problem };
  return { line: `file list matches the pack-contract snapshot on ${tag}` };
}

/** Attestation outcome. */
type AttestationReport = {
  /** Set when the check failed. */
  readonly problem?: string;
  /** Set when the check verified an attestation. */
  readonly line?: string;
};

/**
 * Installs the published version and runs {@link ATTESTATION_CHECK}.
 *
 * @param version - Published version
 * @returns The problem or the success line
 */
async function checkAttestation(version: string): Promise<AttestationReport> {
  const dir = mkdtempSync(join(tmpdir(), "okm-verify-audit-"));
  try {
    const manifest = {
      name: "okm-verify-release",
      private: true,
      dependencies: { [PACKAGE_NAME]: version },
    };
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest)}\n`);
    const installed = await command(dir, [
      "npm",
      "install",
      "--ignore-scripts",
      "--no-fund",
      "--no-audit",
    ]);
    if (installed.code !== 0) {
      return {
        problem: `provenance: could not install ${PACKAGE_NAME}@${version}\n${tail(installed.stderr || installed.stdout)}`,
      };
    }
    const audited = await command(dir, ["npm", "audit", "signatures"]);
    const output = `${audited.stdout}\n${audited.stderr}`;
    const problem = attestationProblem(audited.code, output);
    if (problem !== undefined) return { problem };
    return { line: `provenance: ${ATTESTATION_CHECK} verified the attestation` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Reads one file out of a gzip tarball.
 *
 * @param bytes - Tarball bytes
 * @param path - Path inside the tarball, such as `package/package.json`
 * @returns File text
 */
async function tarballText(bytes: Uint8Array, path: string): Promise<string> {
  const file = await withTarball(bytes, async (tarball) => {
    const extracted = await command(repoRoot(), ["tar", "-xOzf", tarball, path]);
    if (extracted.code !== 0) {
      throw new Error(`tarball has no ${path}\n${tail(extracted.stderr)}`);
    }
    return extracted.stdout;
  });
  return file;
}

/**
 * Lists entries in a gzip tarball.
 *
 * @param bytes - Tarball bytes
 * @returns `tar -tzf` output
 */
async function tarballListing(bytes: Uint8Array): Promise<string> {
  return withTarball(bytes, async (tarball) => {
    const listed = await command(repoRoot(), ["tar", "-tzf", tarball]);
    if (listed.code !== 0) throw new Error(`could not list the tarball\n${tail(listed.stderr)}`);
    return listed.stdout;
  });
}

/**
 * Writes tarball bytes to a temp file for `tar`.
 *
 * @param bytes - Tarball bytes
 * @param fn - Reads the temp path
 * @returns Whatever `fn` returns
 */
async function withTarball<T>(bytes: Uint8Array, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "okm-verify-tgz-"));
  const path = join(dir, "published.tgz");
  try {
    writeFileSync(path, bytes);
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One finished command. */
type CommandResult = {
  /** Exit code. */
  readonly code: number;
  /** Standard output. */
  readonly stdout: string;
  /** Standard error. */
  readonly stderr: string;
};

/**
 * Runs git in the repository.
 *
 * @param root - Repository root
 * @param args - Arguments after `git`
 * @returns The finished command
 */
async function git(root: string, args: readonly string[]): Promise<CommandResult> {
  return command(root, ["git", ...args]);
}

/**
 * Runs a command and captures both streams.
 *
 * @param cwd - Working directory
 * @param args - Argv, including the executable
 * @returns The finished command
 */
async function command(cwd: string, args: readonly string[]): Promise<CommandResult> {
  const proc = Bun.spawn([...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout, stderr };
}

/**
 * @param text - Command output
 * @returns The last lines, for a report
 */
function tail(text: string): string {
  return text.trim().split("\n").slice(-12).join("\n");
}

/**
 * @param value - Unknown JSON
 * @returns Whether `value` is a non-null object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
