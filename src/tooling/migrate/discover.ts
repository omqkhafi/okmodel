/**
 * Nearest `okmodel.config.ts` for a working directory.
 *
 * `--config` is handled by the caller. With no flag, the file in the working
 * directory wins. Otherwise the nearest file above that directory, or in a
 * package below it, is used. Two files at that same distance are a refusal:
 * the command lists them and does not pick one.
 */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve, type PlatformPath } from "node:path";
import path from "node:path";

import { OkmError } from "../../contracts/error.js";
import { tagOutcome } from "../cli/outcome.js";
import { hasGitMarker } from "../workspaces.js";

/** Directories a config search does not enter. */
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", ".okm", ".next", "out"]);

/** One resolved project, or an ambiguous set of configs. */
export type DiscoveredProject = {
  readonly cwd: string;
  readonly configPath: string;
  /** Present when two or more configs share the nearest distance. */
  readonly ambiguous?: readonly string[];
};

/**
 * Resolves the config file for `start`.
 *
 * A file in `start` is distance 0 and is used immediately. The walk upward
 * stops at the git root. The walk downward stays inside `start`, skips
 * symlink directories, and stops after four levels.
 *
 * @param start - Working directory
 * @param configFile - File name, `okmodel.config.ts`
 * @returns The project directory and the config path
 */
export function resolveProject(start: string, configFile: string): DiscoveredProject {
  const cwd = resolve(start);
  const here = join(cwd, configFile);
  if (isConfigFile(here)) return { cwd, configPath: here };
  const picked = pickNearestConfig(cwd, findConfigFiles(cwd, configFile));
  if (picked.kind === "one") return { cwd: dirname(picked.path), configPath: picked.path };
  if (picked.kind === "many") {
    return { cwd, configPath: join(cwd, configFile), ambiguous: picked.paths };
  }
  return { cwd, configPath: join(cwd, configFile) };
}

/**
 * Distance in path segments from `fromDir` to the directory of `configFile`.
 *
 * @param fromDir - Working directory
 * @param configFile - Absolute or relative config path
 * @param paths - Path implementation. Tests pass `path.win32`
 * @returns The distance, or `undefined` when the file is not on this chain
 */
export function configDistance(
  fromDir: string,
  configFile: string,
  paths: PlatformPath = path,
): number | undefined {
  const rel = paths.relative(fromDir, paths.dirname(configFile));
  if (rel === "") return 0;
  if (paths.isAbsolute(rel)) return undefined;
  const parts = rel.split(paths.sep).filter((part) => part.length > 0);
  if (parts.length === 0) return 0;
  const upward = parts.every((part) => part === "..");
  const downward = parts.every((part) => part !== "..");
  if (!upward && !downward) return undefined;
  return parts.length;
}

/**
 * Picks the nearest config, or reports a tie.
 *
 * @param cwd - Working directory
 * @param configs - Candidate config files
 * @param paths - Path implementation. Tests pass `path.win32`
 * @returns None, one file, or the tied files sorted by path
 */
export function pickNearestConfig(
  cwd: string,
  configs: readonly string[],
  paths: PlatformPath = path,
):
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly path: string }
  | { readonly kind: "many"; readonly paths: readonly string[] } {
  const ranked: { path: string; distance: number }[] = [];
  const seen = new Set<string>();
  for (const file of configs) {
    if (seen.has(file)) continue;
    seen.add(file);
    const distance = configDistance(cwd, file, paths);
    if (distance === undefined) continue;
    ranked.push({ path: file, distance });
  }
  if (ranked.length === 0) return { kind: "none" };
  const nearest = Math.min(...ranked.map((item) => item.distance));
  const ties = ranked
    .filter((item) => item.distance === nearest)
    .map((item) => item.path)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const only = ties[0];
  if (ties.length === 1 && only !== undefined) return { kind: "one", path: only };
  return { kind: "many", paths: ties };
}

/**
 * Refuses to guess between two configs at the same distance.
 *
 * @param paths - Config files. Fewer than two is not a refusal
 */
export function refuseAmbiguousConfigs(paths: readonly string[]): void {
  if (paths.length < 2) return;
  const listed = [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  throw tagOutcome(
    new OkmError("OKM1890", `Two configs are equally near: ${listed.join(", ")}.`, {
      kind: "invalid",
      retryable: false,
      fix: { summary: "Pass --config <path> to the config this command should load." },
    }),
    "decision",
  );
}

function findConfigFiles(cwd: string, configFile: string): readonly string[] {
  const found: string[] = [];
  const git = gitRoot(cwd);
  let dir = cwd;
  for (let depth = 0; depth < 32; depth += 1) {
    const file = join(dir, configFile);
    if (isConfigFile(file)) found.push(file);
    if (git !== undefined && dir === git) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  walkDown(cwd, configFile, 0, found);
  return found;
}

function walkDown(dir: string, configFile: string, depth: number, found: string[]): void {
  if (depth >= 4) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && entry.name === configFile && depth > 0) {
      found.push(join(dir, entry.name));
      continue;
    }
    if (!entry.isDirectory()) continue;
    const next = join(dir, entry.name);
    const file = join(next, configFile);
    if (isConfigFile(file)) found.push(file);
    walkDown(next, configFile, depth + 1, found);
  }
}

function gitRoot(start: string): string | undefined {
  let dir = start;
  for (let depth = 0; depth < 32; depth += 1) {
    if (hasGitMarker(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function isConfigFile(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}
