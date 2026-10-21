/**
 * Workspace packages, task runners, and path checks for `okm init`.
 *
 * Reads `package.json` and `pnpm-workspace.yaml`. It does not install, does
 * not connect, and does not follow a symlink out of the directory it was given.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, type PlatformPath } from "node:path";
import path from "node:path";

/** Directories a workspace walk does not enter. */
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", ".okm", ".next", "out"]);

/** How a root forwards package scripts, when it already has a task runner. */
export type TaskRunner = "turbo" | "nx" | "pnpm" | "bun";

/** One workspace package. `rel` uses `/` separators. */
export type WorkspacePackage = {
  /** `package.json` `name`, when it is a string. */
  readonly name?: string;
  /** Absolute directory. */
  readonly dir: string;
  /** Path relative to the workspace root, with `/` separators. */
  readonly rel: string;
  /** Names declared in dependencies, devDependencies, and optionalDependencies. */
  readonly dependencies: ReadonlySet<string>;
};

/**
 * Whether `dir` contains a `.git` file or directory.
 *
 * A gitfile (a worktree) and a normal `.git` directory both count. A symlink
 * counts as the link itself and is not followed.
 *
 * @param dir - Directory that might be a repository root
 * @returns `true` when `.git` is a file, a directory, or a symlink
 */
export function hasGitMarker(dir: string): boolean {
  const git = join(dir, ".git");
  if (!existsSync(git)) return false;
  try {
    const stat = lstatSync(git);
    return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Nearest directory at or above `start` that declares workspaces.
 *
 * `pnpm-workspace.yaml` with a `packages` list wins over `package.json`
 * when both exist in that directory. The walk stops after eight parents.
 *
 * @param start - File or directory to start from
 * @returns The workspace root, or `undefined` when none is declared
 */
export function findWorkspaceRoot(start: string): string | undefined {
  let dir = resolve(start);
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) dir = dirname(dir);
  for (let depth = 0; depth < 8; depth += 1) {
    if (workspaceGlobs(dir) !== undefined) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * Packages selected by the workspace globs.
 *
 * The root package is included only when a glob matches it. The result is
 * sorted by relative path.
 *
 * @param repo - Workspace root from {@link findWorkspaceRoot}
 * @returns The packages. Empty when the globs match nothing
 */
export function listWorkspaces(repo: string): readonly WorkspacePackage[] {
  const globs = workspaceGlobs(repo);
  if (globs === undefined || globs.length === 0) return [];
  const found: WorkspacePackage[] = [];
  for (const dir of packageDirs(repo)) {
    const rel = workspaceRel(repo, dir);
    if (rel.startsWith("..")) continue;
    if (!globSelected(rel, globs)) continue;
    found.push(readWorkspacePackage(dir, rel));
  }
  found.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
  return found;
}

/**
 * The package whose directory contains `dir`, preferring the longest match.
 *
 * @param packages - Packages from {@link listWorkspaces}
 * @param dir - A directory inside the repo
 * @returns The containing package, or `undefined` at the repo root
 */
export function packageContaining(
  packages: readonly WorkspacePackage[],
  dir: string,
): WorkspacePackage | undefined {
  const absolute = resolve(dir);
  let best: WorkspacePackage | undefined;
  for (const pkg of packages) {
    if (!isWithin(pkg.dir, absolute)) continue;
    if (best === undefined || pkg.dir.length > best.dir.length) best = pkg;
  }
  return best;
}

/**
 * Whether `child` is `parent` or a directory inside it.
 *
 * @param parent - Parent directory
 * @param child - Candidate path
 * @param paths - Path implementation. Tests pass `path.win32`
 * @returns `true` when `child` does not escape `parent`
 */
export function isWithin(parent: string, child: string, paths: PlatformPath = path): boolean {
  const rel = paths.relative(parent, child);
  if (rel === "") return true;
  if (paths.isAbsolute(rel)) return false;
  return !rel.split(paths.sep).includes("..");
}

/**
 * Relative path from `fromDir` to `toFile` with `/` separators.
 *
 * A path that does not start with `.` gains a `./` prefix so it can be a
 * TypeScript import specifier.
 *
 * @param fromDir - Directory the import is written in
 * @param toFile - File the import names
 * @param paths - Path implementation. Tests pass `path.win32`
 * @returns The specifier
 */
export function posixRelative(fromDir: string, toFile: string, paths: PlatformPath = path): string {
  const rel = paths.relative(fromDir, toFile);
  if (rel === "") return ".";
  const spec = rel.split(paths.sep).join("/");
  if (spec.startsWith(".")) return spec;
  return `./${spec}`;
}

/**
 * Task runner the repo already uses.
 *
 * `turbo.json` and `nx.json` win. Otherwise a root script that already
 * calls `pnpm -r` or `bun --filter` selects that runner. A repo with none
 * of these gets no root scripts.
 *
 * @param repo - Workspace root
 * @param packageText - Root `package.json` text
 * @returns The runner, or `undefined` when root scripts stay untouched
 */
export function detectTaskRunner(repo: string, packageText: string): TaskRunner | undefined {
  if (isFile(join(repo, "turbo.json"))) return "turbo";
  if (isFile(join(repo, "nx.json"))) return "nx";
  if (/\bpnpm(?:\s+-r|\s+--recursive|\s+recursive)\b/.test(packageText)) return "pnpm";
  if (/\bbun(?:\s+run)?\s+--filter\b/.test(packageText)) return "bun";
  return undefined;
}

/**
 * Root script that forwards one package script through `runner`.
 *
 * @param runner - Runner from {@link detectTaskRunner}
 * @param name - Script name, such as `db:check`
 * @returns The command
 */
export function forwardScript(runner: TaskRunner, name: string): string {
  switch (runner) {
    case "turbo":
      return `turbo run ${name}`;
    case "nx":
      return `nx run-many -t ${name}`;
    case "pnpm":
      return `pnpm -r ${name}`;
    case "bun":
      return `bun run --filter '*' ${name}`;
  }
}

/**
 * Whether a pnpm catalog already publishes `okmodel`.
 *
 * The catalog is not edited. A missing file is not a catalog.
 *
 * @param repo - Workspace root
 * @returns `true` when `okmodel` is a key under `catalog` or `catalogs`
 */
export function catalogHasOkmodel(repo: string): boolean {
  const file = join(repo, "pnpm-workspace.yaml");
  if (!isFile(file)) return false;
  return catalogTextHasOkmodel(readFileSync(file, "utf8"));
}

/**
 * Whether `text` lists `okmodel` inside a catalog block.
 *
 * @param text - `pnpm-workspace.yaml` contents
 * @returns `true` when a catalog key is `okmodel`
 */
export function catalogTextHasOkmodel(text: string): boolean {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let catalogIndent: number | undefined;
  for (const line of lines) {
    const trimmed = stripYamlComment(line).trim();
    if (trimmed.length === 0) continue;
    const indent = line.length - line.trimStart().length;
    if (catalogIndent !== undefined && indent <= catalogIndent) catalogIndent = undefined;
    if (/^catalogs?\s*:/.test(trimmed)) {
      catalogIndent = indent;
      continue;
    }
    if (catalogIndent !== undefined && indent > catalogIndent && /^okmodel\s*:/.test(trimmed)) {
      return true;
    }
  }
  return false;
}

function workspaceRel(repo: string, dir: string): string {
  const rel = relative(repo, dir).split(path.sep).join("/");
  if (rel.startsWith("..")) return rel;
  return rel === "." || rel.length === 0 ? "" : rel;
}

function workspaceGlobs(dir: string): readonly string[] | undefined {
  const yaml = join(dir, "pnpm-workspace.yaml");
  if (isFile(yaml)) {
    const globs = pnpmPackageGlobs(readFileSync(yaml, "utf8"));
    if (globs.length > 0) return globs;
  }
  const pkg = join(dir, "package.json");
  if (!isFile(pkg)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkg, "utf8"));
    const globs = packageWorkspaceGlobs(parsed);
    return globs.length > 0 ? globs : undefined;
  } catch {
    return undefined;
  }
}

function packageWorkspaceGlobs(parsed: unknown): readonly string[] {
  if (!isRecord(parsed)) return [];
  const field = parsed.workspaces;
  if (Array.isArray(field)) return stringItems(field);
  if (isRecord(field) && Array.isArray(field.packages)) return stringItems(field.packages);
  return [];
}

function pnpmPackageGlobs(text: string): readonly string[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let inPackages = false;
  let packagesIndent = 0;
  const globs: string[] = [];
  for (const line of lines) {
    const trimmed = stripYamlComment(line).trim();
    if (trimmed.length === 0) continue;
    const indent = line.length - line.trimStart().length;
    if (!inPackages) {
      if (/^packages\s*:/.test(trimmed)) {
        inPackages = true;
        packagesIndent = indent;
      }
      continue;
    }
    if (indent <= packagesIndent) break;
    const item = /^-\s+(.+)$/.exec(trimmed);
    const value = item?.[1]?.trim().replace(/^['"]|['"]$/g, "");
    if (value !== undefined && value.length > 0) globs.push(value);
  }
  return globs;
}

function packageDirs(repo: string): readonly string[] {
  const found: string[] = [];
  if (isFile(join(repo, "package.json"))) found.push(repo);
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const next = join(dir, entry.name);
      if (isFile(join(next, "package.json"))) found.push(next);
      walk(next, depth + 1);
    }
  };
  walk(repo, 0);
  return found;
}

function readWorkspacePackage(dir: string, rel: string): WorkspacePackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    parsed = undefined;
  }
  const record = isRecord(parsed) ? parsed : {};
  const dependencies = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const bag = record[key];
    if (!isRecord(bag)) continue;
    for (const name of Object.keys(bag)) dependencies.add(name);
  }
  const name = typeof record.name === "string" ? record.name : undefined;
  return {
    ...(name === undefined ? {} : { name }),
    dir,
    rel: rel === "." ? "" : rel,
    dependencies,
  };
}

function globSelected(rel: string, globs: readonly string[]): boolean {
  const subject = rel.length === 0 ? "." : rel;
  let matched = false;
  for (const glob of globs) {
    if (glob.startsWith("!")) {
      if (matchGlob(glob.slice(1), subject)) return false;
      continue;
    }
    if (matchGlob(glob, subject)) matched = true;
  }
  return matched;
}

function matchGlob(pattern: string, rel: string): boolean {
  const glob = pattern.split("/").filter((part) => part.length > 0);
  const parts = rel === "." ? [] : rel.split("/").filter((part) => part.length > 0);
  return matchParts(glob, 0, parts, 0);
}

function matchParts(
  glob: readonly string[],
  globIndex: number,
  parts: readonly string[],
  partIndex: number,
): boolean {
  if (globIndex === glob.length) return partIndex === parts.length;
  const head = glob[globIndex] ?? "";
  if (head === "**") {
    if (matchParts(glob, globIndex + 1, parts, partIndex)) return true;
    if (partIndex === parts.length) return false;
    return matchParts(glob, globIndex, parts, partIndex + 1);
  }
  if (partIndex === parts.length) return false;
  if (!segmentMatch(head, parts[partIndex] ?? "")) return false;
  return matchParts(glob, globIndex + 1, parts, partIndex + 1);
}

function segmentMatch(pattern: string, text: string): boolean {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += escapeRegExp(char);
  }
  source += "$";
  return new RegExp(source).test(text);
}

function escapeRegExp(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function stringItems(values: readonly unknown[]): readonly string[] {
  const items: string[] = [];
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) items.push(value);
  }
  return items;
}

function stripYamlComment(line: string): string {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === undefined && char === "#") return line.slice(0, index);
    if (quote === undefined && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    if (char === quote) quote = undefined;
  }
  return line;
}

function isFile(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
