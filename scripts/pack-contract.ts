/**
 * Fails unless the packed file list and the `exports` map match a snapshot.
 *
 * `bunx npm pack --dry-run --json` is the file list. The snapshot is
 * committed, so a change to either list is a diff in the pull request.
 * Bun names split chunks `dist/shared/<hash>.js` and
 * `dist/tooling/shared/<hash>.js` (`--chunk-naming=shared/[hash].js`).
 * Those paths are stored as `dist/shared/*.js` and
 * `dist/tooling/shared/*.js`. The count of each name stays exact.
 * A different hash with the same count passes. A new or removed chunk fails.
 * `package.json` must have no `preinstall`, `install`, `postinstall`, or
 * `prepare` script, empty `dependencies`, a `files` allowlist, and optional
 * peer dependencies.
 *
 *   bun ./scripts/pack-contract.ts
 *   bun ./scripts/pack-contract.ts --update
 *   bun ./scripts/pack-contract.ts --root <dir>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { packSizeProblems, readPackSizeBaseline } from "./pack-size.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";
import { restorePackedDocs } from "./docs-pack.js";
import { restoreWorkspaces } from "./strip-workspaces.js";

/** Install-time scripts the published manifest must not define. */
export const FORBIDDEN_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"] as const;

/** Snapshot path used for this repository. */
export const DEFAULT_SNAPSHOT = "tests/fixtures/pack-contract.snap.json";

/** Packed paths plus the `exports` map. */
export type PackSnapshot = {
  /** Paths `npm pack --dry-run --json` lists, sorted. */
  readonly files: readonly string[];
  /** `package.json` `exports`, or null when the field is absent. */
  readonly exports: unknown;
};

/**
 * Problems in a manifest that must not be published.
 *
 * @param manifest - Parsed `package.json`
 * @returns Problem lines. Empty when the manifest matches the contract
 */
export function manifestProblems(manifest: unknown): readonly string[] {
  if (!isRecord(manifest)) return ["pack-contract: package.json is not an object"];
  return [
    ...scriptProblems(manifest),
    ...dependencyProblems(manifest),
    ...filesProblems(manifest),
    ...peerProblems(manifest),
  ];
}

/**
 * Bun's content-hash chunk names.
 *
 * The basename is the hash from `--chunk-naming=shared/[hash].js`. There is
 * no stable chunk name in front of it. `dist/runtime/ids/okid-shared.d.ts`
 * does not match: the directory is `dist/shared` or `dist/tooling/shared`,
 * and the file is `<hash>.js`.
 */
const CHUNK_PATH = /^dist\/((?:tooling\/)?shared)\/[0-9a-z]+\.js$/;

/**
 * Replaces a content-hash chunk basename with `*`.
 *
 * `dist/shared/0212d69d.js` becomes `dist/shared/*.js`.
 * `dist/tooling/shared/016qrjk3.js` becomes `dist/tooling/shared/*.js`.
 * Any other path is unchanged. A path that is already normalised stays
 * unchanged, because `*` is not a hash character.
 *
 * @param path - One packed path
 * @returns The path the snapshot stores
 */
export function normalizePackedPath(path: string): string {
  const match = CHUNK_PATH.exec(path);
  if (match === null) return path;
  return `dist/${match[1]}/*.js`;
}

/**
 * Paths present on one side of the snapshot only.
 *
 * Chunk hashes are compared by the count of each normalised name. Two lists
 * with the same files and different hashes match. One more or one fewer
 * chunk does not.
 *
 * @param actual - Paths from `npm pack`
 * @param expected - Paths in the snapshot
 * @returns Extra packed paths and snapshot paths that were not packed
 */
export function packedFileDiff(
  actual: readonly string[],
  expected: readonly string[],
): { readonly extra: readonly string[]; readonly missing: readonly string[] } {
  const actualCounts = pathCounts(actual);
  const expectedCounts = pathCounts(expected);
  const names = [...new Set([...actualCounts.keys(), ...expectedCounts.keys()])].sort();
  const extra: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const got = actualCounts.get(name) ?? 0;
    const want = expectedCounts.get(name) ?? 0;
    for (let index = 0; index < got - want; index += 1) extra.push(name);
    for (let index = 0; index < want - got; index += 1) missing.push(name);
  }
  return { extra, missing };
}

/**
 * Counts normalised packed paths.
 *
 * @param paths - Packed or snapshot paths
 * @returns How many files share each normalised name
 */
function pathCounts(paths: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const name = normalizePackedPath(path);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      snapshot: { type: "string" },
      update: { type: "boolean", default: false },
    },
    args: process.argv.slice(2),
    strict: true,
  });
  const root = values.root === undefined || values.root.length === 0 ? repoRoot() : values.root;
  const snapshotPath = resolveSnapshot(root, values.snapshot);
  const manifest = readManifest(root);
  const problems = [...manifestProblems(manifest)];
  if (problems.length > 0) exitOnProblems(problems);

  const packed = await readPacked(root).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    exitOnProblems([`pack-contract: ${message}`]);
    throw error;
  });
  const exportsField = isRecord(manifest) && "exports" in manifest ? manifest.exports : null;
  const next: PackSnapshot = {
    files: packed.files.map((path) => normalizePackedPath(path)).sort(),
    exports: exportsField ?? null,
  };
  const drift: string[] = values.update ? [] : [...compareSnapshot(snapshotPath, next)];
  if (!values.update) {
    try {
      drift.push(...packSizeProblems(packed.bytes, readPackSizeBaseline(root)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      drift.push(message);
    }
  }
  if (values.update) {
    writeFileSync(snapshotPath, `${canonical(next)}\n`);
    console.log(`pack-contract: wrote ${snapshotPath}`);
  }
  exitOnProblems(drift);
}

/**
 * Compares a pack result to the committed snapshot.
 *
 * @param snapshotPath - Snapshot file
 * @param next - Packed paths and exports from the tree
 * @returns Problem lines. Empty when they match
 */
function compareSnapshot(snapshotPath: string, next: PackSnapshot): readonly string[] {
  let snapshot: PackSnapshot;
  try {
    snapshot = readSnapshot(snapshotPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`pack-contract: ${message}`];
  }
  const problems: string[] = [];
  if (canonical(next.exports) !== canonical(snapshot.exports)) {
    problems.push(
      `pack-contract: exports differ from ${snapshotPath}. Run with --update and commit the snapshot.`,
    );
  }
  const diff = packedFileDiff(next.files, snapshot.files);
  if (diff.extra.length > 0 || diff.missing.length > 0) {
    problems.push(`pack-contract: packed files differ from ${snapshotPath}`);
    for (const path of diff.extra) problems.push(`  + ${path}`);
    for (const path of diff.missing) problems.push(`  - ${path}`);
  }
  return problems;
}

/** Files and tarball size from one `npm pack --dry-run --json`. */
export type PackedTarball = {
  /** Sorted packed paths. */
  readonly files: readonly string[];
  /** Tarball size in bytes (`size` in the npm JSON). */
  readonly bytes: number;
};

/**
 * Lists files `npm pack --dry-run --json` would put in the tarball.
 *
 * Restores a `prepack` workspace strip and a docs stamp if npm stops
 * before `postpack`.
 *
 * @param root - Package directory
 * @returns Sorted packed paths and the tarball size
 */
export async function readPacked(root: string): Promise<PackedTarball> {
  try {
    const proc = Bun.spawn(["bunx", "npm", "pack", "--dry-run", "--json"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(stderr.trim() || `npm pack exited ${String(code)}`);
    }
    const payload = parsePack(stdout);
    return { files: filePaths(payload), bytes: tarballBytes(payload) };
  } finally {
    restorePackedDocs(root);
    restoreWorkspaces(root);
  }
}

/**
 * Reads and sorts the packed paths from npm's JSON.
 *
 * @param payload - Parsed `npm pack --dry-run --json` output
 * @returns Sorted relative paths
 */
/**
 * Tarball `size` from npm's JSON, in bytes.
 *
 * @param payload - Parsed `npm pack --dry-run --json` output
 * @returns The packed size
 */
function tarballBytes(payload: unknown): number {
  const entry = Array.isArray(payload) ? payload[0] : payload;
  if (!isRecord(entry) || typeof entry.size !== "number" || !Number.isInteger(entry.size)) {
    throw new Error("npm pack JSON has no integer size");
  }
  return entry.size;
}

function filePaths(payload: unknown): readonly string[] {
  const entry = Array.isArray(payload) ? payload[0] : payload;
  if (!isRecord(entry) || !Array.isArray(entry.files)) {
    throw new Error("npm pack JSON has no files array");
  }
  const paths: string[] = [];
  for (const file of entry.files) {
    if (!isRecord(file) || typeof file.path !== "string" || file.path.length === 0) {
      throw new Error("npm pack JSON has a file without a path");
    }
    paths.push(file.path);
  }
  return [...paths].sort();
}

/**
 * Parses npm's JSON from stdout, ignoring any text before the document.
 *
 * @param stdout - Combined standard output
 * @returns The parsed document
 */
function parsePack(stdout: string): unknown {
  const start = stdout.search(/[[{]/);
  if (start === -1) throw new Error("npm pack did not print JSON");
  return JSON.parse(stdout.slice(start)) as unknown;
}

/**
 * Reads `package.json`.
 *
 * @param root - Package directory
 * @returns The parsed manifest
 */
function readManifest(root: string): unknown {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as unknown;
}

/**
 * Reads a snapshot file.
 *
 * @param path - Snapshot path
 * @returns The parsed snapshot
 */
function readSnapshot(path: string): PackSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`snapshot is missing: ${path}. Run with --update and commit the snapshot.`);
    }
    throw error;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.files)) {
    throw new Error(`snapshot is not a pack contract: ${path}`);
  }
  const files: string[] = [];
  for (const file of parsed.files) {
    if (typeof file !== "string") throw new Error(`snapshot is not a pack contract: ${path}`);
    files.push(file);
  }
  return { files, exports: "exports" in parsed ? parsed.exports : null };
}

/**
 * Snapshot path for a package root.
 *
 * The repository snapshot stays at {@link DEFAULT_SNAPSHOT}. Another root
 * keeps its snapshot next to `package.json` unless `--snapshot` is set.
 *
 * @param root - Package directory
 * @param explicit - `--snapshot`, when passed
 * @returns Absolute snapshot path
 */
function resolveSnapshot(root: string, explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);
  if (resolve(root) === resolve(repoRoot())) return resolve(root, DEFAULT_SNAPSHOT);
  return resolve(root, "pack-contract.snap.json");
}

/**
 * Stable JSON with sorted object keys.
 *
 * @param value - Any JSON value
 * @returns Pretty JSON without a trailing newline
 */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) ?? "null";
}

/**
 * Recursively sorts object keys so a snapshot diff ignores key order.
 *
 * @param value - Any JSON value
 * @returns A copy with sorted keys
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeys(item));
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
  return sorted;
}

/**
 * @param manifest - Parsed `package.json`
 * @returns One line per forbidden script that is set
 */
function scriptProblems(manifest: Record<string, unknown>): readonly string[] {
  const scripts = manifest.scripts;
  if (scripts === undefined) return [];
  if (!isRecord(scripts)) return ["pack-contract: scripts is not an object"];
  const problems: string[] = [];
  for (const name of FORBIDDEN_SCRIPTS) {
    if (name in scripts) problems.push(`pack-contract: scripts.${name} is set`);
  }
  return problems;
}

/**
 * @param manifest - Parsed `package.json`
 * @returns A problem when `dependencies` is present and not empty
 */
function dependencyProblems(manifest: Record<string, unknown>): readonly string[] {
  const dependencies = manifest.dependencies;
  if (dependencies === undefined) return [];
  if (!isRecord(dependencies)) return ["pack-contract: dependencies is not an object"];
  const names = Object.keys(dependencies).sort();
  if (names.length === 0) return [];
  return [`pack-contract: dependencies is not empty (${names.join(", ")})`];
}

/**
 * @param manifest - Parsed `package.json`
 * @returns A problem when `files` is missing or empty
 */
function filesProblems(manifest: Record<string, unknown>): readonly string[] {
  const files = manifest.files;
  if (!Array.isArray(files) || files.length === 0) {
    return ["pack-contract: files allowlist is missing"];
  }
  if (files.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    return ["pack-contract: files allowlist is missing"];
  }
  return [];
}

/**
 * @param manifest - Parsed `package.json`
 * @returns One line per peer that is not marked optional
 */
function peerProblems(manifest: Record<string, unknown>): readonly string[] {
  const peers = manifest.peerDependencies;
  if (peers === undefined) return [];
  if (!isRecord(peers)) return ["pack-contract: peerDependencies is not an object"];
  const meta = manifest.peerDependenciesMeta;
  const metaRecord = isRecord(meta) ? meta : {};
  const problems: string[] = [];
  for (const name of Object.keys(peers).sort()) {
    const entry = metaRecord[name];
    if (!isRecord(entry) || entry.optional !== true) {
      problems.push(`pack-contract: peer dependency ${name} is not optional`);
    }
  }
  return problems;
}

/**
 * @param value - Unknown JSON
 * @returns Whether `value` is a non-null object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
