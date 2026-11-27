/**
 * Fails unless the public surface matches a snapshot and the tarball's
 * required files are present.
 *
 * `bunx npm@11.15.0 pack --dry-run --json` lists the tarball. The npm
 * version is pinned so `bunx` does not download whatever npm is current.
 * npm 11 prints a JSON array. npm 12 prints an object keyed by package
 * name. Both shapes are accepted.
 *
 * The snapshot records `exports`, `bin`, `main`, and the sha256 of each
 * public declaration (`exports` `types`). It does not record internal
 * chunk names, chunk counts, or generated error pages. `bin` and `main`
 * are the paths in `package.json`. The snapshot does not pin the contents
 * of those files. A missing required file or a forbidden file fails on
 * its own and does not ask for `--update`.
 *
 * `package.json` must have no `preinstall`, `install`, `postinstall`, or
 * `prepare` script, empty `dependencies`, `optionalDependencies`,
 * `bundleDependencies`, and `bundledDependencies`, a `files` allowlist,
 * and optional peer dependencies.
 *
 *   bun ./scripts/pack-contract.ts
 *   bun ./scripts/pack-contract.ts --update
 *   bun ./scripts/pack-contract.ts --root <dir>
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";
import { restorePackedDocs } from "./docs-pack.js";
import { restoreWorkspaces } from "./strip-workspaces.js";

/** Install-time scripts the published manifest must not define. */
export const FORBIDDEN_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"] as const;

/** The one command that rewrites the committed snapshot. Named by every drift failure. */
const UPDATE_SNAPSHOT = "bun ./scripts/pack-contract.ts --update";

/**
 * @param detail - What drifted
 * @returns That detail plus the snapshot command
 */
function snapshotDrift(detail: string): string {
  return `${detail} ${UPDATE_SNAPSHOT}`;
}

/**
 * npm used for `npm pack --dry-run --json`.
 *
 * `bunx npm` without a version downloads the latest npm when none is on
 * `PATH`. npm 12 changed the JSON shape. This pin stays on the array shape,
 * and {@link packedTarballFromJson} still accepts the npm 12 object.
 */
export const PACK_NPM_VERSION = "11.15.0";

/** Snapshot path used for this repository. */
export const DEFAULT_SNAPSHOT = "tests/fixtures/pack-contract.snap.json";

/**
 * Arguments for one dry-run pack.
 *
 * @returns The argv, without a shell
 */
export function packNpmArgs(): readonly string[] {
  return ["bunx", `npm@${PACK_NPM_VERSION}`, "pack", "--dry-run", "--json"];
}

/** Public surface the snapshot records. */
export type PackSnapshot = {
  /** `package.json` `exports`, or null when the field is absent. */
  readonly exports: unknown;
  /** `package.json` `bin`, or null when the field is absent. Paths, not file bytes. */
  readonly bin: unknown;
  /** `package.json` `main`, or null when the field is absent. A path, not file bytes. */
  readonly main: unknown;
  /**
   * sha256 of each `exports` `types` file, keyed by the export path.
   * Absent keys are exports with no `types` condition.
   */
  readonly declarations: Readonly<Record<string, string>>;
};

/** Path prefixes that must not appear in a published tarball. */
const FORBIDDEN_PREFIXES = ["node_modules/", ".github/", "tests/", "coverage/"] as const;

/** File names that must not appear in a published tarball. */
const FORBIDDEN_SUFFIXES = [".test.ts", ".test.js", ".test-d.ts"] as const;

/** Names packed when they exist beside `package.json`. */
const OPTIONAL_ROOT_FILES = ["README.md", "LICENSE", "LICENCE"] as const;

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
    ...optionalDependencyProblems(manifest),
    ...bundleDependencyProblems(manifest),
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
  const next = publicSurface(root, manifest);
  const presence = packedPresenceProblems(packed.files, requiredPackedPaths(manifest, root));
  const drift: string[] = values.update ? [] : [...compareSnapshot(snapshotPath, next)];
  if (values.update) {
    writeFileSync(snapshotPath, `${canonical(next)}\n`);
    console.log(`pack-contract: wrote ${snapshotPath}`);
  }
  exitOnProblems([...presence, ...drift]);
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
    problems.push(snapshotDrift(`pack-contract: exports differ from ${snapshotPath}.`));
  }
  if (canonical(next.bin) !== canonical(snapshot.bin)) {
    problems.push(snapshotDrift(`pack-contract: bin differs from ${snapshotPath}.`));
  }
  if (canonical(next.main) !== canonical(snapshot.main)) {
    problems.push(snapshotDrift(`pack-contract: main differs from ${snapshotPath}.`));
  }
  const names = [
    ...new Set([...Object.keys(next.declarations), ...Object.keys(snapshot.declarations)]),
  ].sort();
  for (const name of names) {
    const got = next.declarations[name];
    const want = snapshot.declarations[name];
    if (got === want) continue;
    if (got === undefined) {
      problems.push(
        snapshotDrift(`pack-contract: declaration ${name} is missing from the public surface.`),
      );
      continue;
    }
    problems.push(
      snapshotDrift(
        `pack-contract: declaration ${name} differs from ${snapshotPath} (${want === undefined ? "not recorded" : want} -> ${got}).`,
      ),
    );
  }
  return problems;
}

/**
 * Builds the public surface from the manifest and the declaration files on disk.
 *
 * A missing declaration file is omitted. {@link packedPresenceProblems} reports it.
 *
 * @param root - Package directory
 * @param manifest - Parsed `package.json`
 * @returns The snapshot body
 */
export function publicSurface(root: string, manifest: unknown): PackSnapshot {
  const exportsField = isRecord(manifest) && "exports" in manifest ? manifest.exports : null;
  const binField = isRecord(manifest) && "bin" in manifest ? manifest.bin : null;
  const mainField = isRecord(manifest) && "main" in manifest ? manifest.main : null;
  const declarations: Record<string, string> = {};
  for (const [name, path] of declarationTargets(exportsField)) {
    const file = resolve(root, path);
    if (!existsSync(file)) continue;
    declarations[name] = fileSha256(readFileSync(file));
  }
  return {
    exports: exportsField ?? null,
    bin: binField ?? null,
    main: mainField ?? null,
    declarations,
  };
}

/**
 * Export paths whose `types` condition is a relative file.
 *
 * @param exportsField - `package.json` `exports`
 * @returns Export path to the declaration path, with `./` removed
 */
export function declarationTargets(exportsField: unknown): ReadonlyMap<string, string> {
  const targets = new Map<string, string>();
  if (!isRecord(exportsField)) return targets;
  for (const [name, value] of Object.entries(exportsField)) {
    if (!isRecord(value) || typeof value.types !== "string") continue;
    const relative = relativePackedPath(value.types);
    if (relative !== undefined) targets.set(name, relative);
  }
  return targets;
}

/**
 * Files the tarball must contain.
 *
 * `package.json` is always required. `README.md`, `LICENSE`, and `LICENCE`
 * are required when they exist beside it. Every relative path in `exports`,
 * `bin`, and `main` is required.
 *
 * @param manifest - Parsed `package.json`, or a snapshot's exports, bin, and main
 * @param root - Package directory. When set, README and license files that exist are required
 * @returns Packed paths, without a leading `./`
 */
export function requiredPackedPaths(manifest: unknown, root?: string): readonly string[] {
  const paths = new Set<string>(["package.json"]);
  if (root !== undefined) {
    for (const name of OPTIONAL_ROOT_FILES) {
      if (existsSync(resolve(root, name))) paths.add(name);
    }
  }
  if (!isRecord(manifest)) return [...paths].sort();
  collectRelativePaths(manifest.exports, paths);
  collectRelativePaths(manifest.bin, paths);
  collectRelativePaths(manifest.main, paths);
  return [...paths].sort();
}

/**
 * Missing required files and forbidden packed files.
 *
 * These are not snapshot drift. The message does not name `--update`.
 *
 * @param packed - Paths `npm pack` listed
 * @param required - Paths from {@link requiredPackedPaths}
 * @returns Problem lines
 */
export function packedPresenceProblems(
  packed: readonly string[],
  required: readonly string[],
): readonly string[] {
  const present = new Set(packed);
  const problems: string[] = [];
  for (const path of required) {
    if (!present.has(path)) problems.push(`pack-contract: required file missing: ${path}`);
  }
  for (const path of packed) {
    if (isForbiddenPackedPath(path)) problems.push(`pack-contract: forbidden file: ${path}`);
  }
  return problems;
}

/**
 * @param path - One packed path
 * @returns Whether the path is a test, a workflow, or a dependency tree
 */
export function isForbiddenPackedPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const forbiddenPrefix = FORBIDDEN_PREFIXES.some(
    (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
  );
  if (forbiddenPrefix) return true;
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return FORBIDDEN_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

/**
 * sha256 of file bytes, hex encoded.
 *
 * @param bytes - File contents
 * @returns The digest
 */
export function fileSha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function collectRelativePaths(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    const relative = relativePackedPath(value);
    if (relative !== undefined) into.add(relative);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRelativePaths(item, into);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectRelativePaths(item, into);
  }
}

function relativePackedPath(value: string): string | undefined {
  if (value.startsWith("./")) return value.slice(2);
  if (value.startsWith("../")) return value;
  return undefined;
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
    const proc = Bun.spawn([...packNpmArgs()], {
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
    return packedTarballFromJson(payload);
  } finally {
    restorePackedDocs(root);
    restoreWorkspaces(root);
  }
}

/**
 * Files and size from either npm pack JSON shape.
 *
 * An array is npm 11 (numeric keys merged back into an array). An object
 * keyed by package name is npm 12. A single entry object is accepted too.
 *
 * @param payload - Parsed `npm pack --dry-run --json` output
 * @returns Sorted packed paths and the tarball size
 */
export function packedTarballFromJson(payload: unknown): PackedTarball {
  const entry = packEntry(payload);
  return { files: filePaths(entry), bytes: tarballBytes(entry) };
}

/**
 * The one pack entry inside npm's JSON.
 *
 * @param payload - Parsed `npm pack --dry-run --json` output
 * @returns The entry that lists `files`
 */
function packEntry(payload: unknown): Record<string, unknown> {
  if (Array.isArray(payload)) {
    const entry = payload[0];
    if (!isRecord(entry)) throw new Error("npm pack JSON has no files array");
    return entry;
  }
  if (!isRecord(payload)) throw new Error("npm pack JSON has no files array");
  if (Array.isArray(payload.files)) return payload;
  const entries: Record<string, unknown>[] = [];
  for (const value of Object.values(payload)) {
    if (isRecord(value) && Array.isArray(value.files)) {
      entries.push(value);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (isRecord(item) && Array.isArray(item.files)) entries.push(item);
    }
  }
  const entry = entries[0];
  if (entry === undefined) throw new Error("npm pack JSON has no files array");
  if (entries.length > 1) throw new Error("npm pack JSON lists more than one package");
  return entry;
}

/**
 * Tarball `size` from one pack entry, in bytes.
 *
 * @param entry - One element of `npm pack --dry-run --json`
 * @returns The packed size
 */
function tarballBytes(entry: Record<string, unknown>): number {
  if (typeof entry.size !== "number" || !Number.isInteger(entry.size)) {
    throw new Error("npm pack JSON has no integer size");
  }
  return entry.size;
}

function filePaths(entry: Record<string, unknown>): readonly string[] {
  if (!Array.isArray(entry.files)) {
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
      throw new Error(snapshotDrift(`snapshot is missing: ${path}.`));
    }
    throw error;
  }
  if (!isRecord(parsed)) {
    throw new Error(`snapshot is not a pack contract: ${path}`);
  }
  if (!isRecord(parsed.declarations)) {
    throw new Error(snapshotDrift(`snapshot predates the public-surface record: ${path}.`));
  }
  const declarations: Record<string, string> = {};
  for (const [name, hash] of Object.entries(parsed.declarations)) {
    if (typeof hash !== "string") throw new Error(`snapshot is not a pack contract: ${path}`);
    declarations[name] = hash;
  }
  return {
    exports: "exports" in parsed ? parsed.exports : null,
    bin: "bin" in parsed ? parsed.bin : null,
    main: "main" in parsed ? parsed.main : null,
    declarations,
  };
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
 * @returns A problem when `optionalDependencies` is present and not empty
 */
function optionalDependencyProblems(manifest: Record<string, unknown>): readonly string[] {
  const dependencies = manifest.optionalDependencies;
  if (dependencies === undefined) return [];
  if (!isRecord(dependencies)) return ["pack-contract: optionalDependencies is not an object"];
  const names = Object.keys(dependencies).sort();
  if (names.length === 0) return [];
  return [`pack-contract: optionalDependencies is not empty (${names.join(", ")})`];
}

/**
 * @param manifest - Parsed `package.json`
 * @returns A problem when a bundled dependency list is present and not empty
 */
function bundleDependencyProblems(manifest: Record<string, unknown>): readonly string[] {
  const problems: string[] = [];
  for (const key of ["bundleDependencies", "bundledDependencies"] as const) {
    if (!(key in manifest)) continue;
    const names = bundleNames(manifest[key]);
    if (names === undefined) {
      problems.push(`pack-contract: ${key} is not an array of names`);
      continue;
    }
    if (names.length === 0) continue;
    problems.push(`pack-contract: ${key} is not empty (${[...names].sort().join(", ")})`);
  }
  return problems;
}

/**
 * @param value - `bundleDependencies` or `bundledDependencies`
 * @returns The names, or undefined when the field is not a list of names
 */
function bundleNames(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) return undefined;
    names.push(item);
  }
  return names;
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
