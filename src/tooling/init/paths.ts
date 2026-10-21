/**
 * Paths `okm init` may read and write.
 *
 * Every write stays inside the project root. A symlink that resolves outside
 * that root is refused. `.env` and `.env.local` are never opened.
 */

import { lstatSync, realpathSync, existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { projectPath } from "../migrate/paths.js";
import { refuseUnsupported } from "./guards.js";

/** File names init never reads. Values in these files are not loaded. */
const NEVER_READ = new Set([".env", ".env.local", ".env.development", ".env.production"]);

/**
 * Project-relative POSIX path with no `.` or `..` segments.
 *
 * Backslashes are separators, the same as on Windows. An absolute path is
 * refused.
 *
 * @param input - Flag or file name
 * @returns The normalised relative path
 */
export function normalizeInitPath(input: string): string {
  const slashed = input.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:\//.test(slashed)) {
    refuseUnsupported("okm init does not write an absolute path.");
  }
  const parts = slashed.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    refuseUnsupported("okm init does not write outside the project directory.");
  }
  return parts.join("/");
}

/**
 * Absolute path of a project file that stays inside `root`.
 *
 * Missing parents are allowed. An existing symlink is resolved, and the
 * result must still be inside the root.
 *
 * @param root - Project directory
 * @param rel - Project-relative path from {@link normalizeInitPath}
 * @returns Absolute path to create or read
 */
export function resolveInside(root: string, rel: string): string {
  const normalized = normalizeInitPath(rel);
  const rootReal = existingReal(root);
  const parts = normalized.split("/");
  let current = rootReal;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    const next = join(current, part);
    if (!existsSync(next)) {
      const target = join(current, ...parts.slice(index));
      assertInside(rootReal, target);
      return target;
    }
    const stat = lstatSync(next);
    if (stat.isSymbolicLink()) {
      const resolved = realpathSync(next);
      assertInside(rootReal, resolved);
      if (index === parts.length - 1) return resolved;
      current = resolved;
      continue;
    }
    if (index === parts.length - 1) {
      assertInside(rootReal, next);
      return next;
    }
    if (!stat.isDirectory()) {
      refuseUnsupported(`${normalized} is not a directory inside the project.`);
    }
    current = realpathSync(next);
    assertInside(rootReal, current);
  }
  return current;
}

/**
 * Joins a relative path onto the project using {@link projectPath}, then
 * checks the result stays inside the root.
 *
 * @param root - Project directory
 * @param rel - Relative path
 * @returns Absolute path
 */
export function initProjectPath(root: string, rel: string): string {
  const normalized = normalizeInitPath(rel);
  const joined = projectPath(root, ...normalized.split("/"));
  return resolveInside(root, relative(existingReal(root), joined).split(sep).join("/"));
}

/**
 * Whether init may read this project-relative file.
 *
 * @param rel - Project-relative path
 * @returns `false` for `.env` and the local env files
 */
export function mayReadProjectFile(rel: string): boolean {
  const base = rel.replaceAll("\\", "/").split("/").at(-1) ?? "";
  if (base === ".env.example") return true;
  if (NEVER_READ.has(base)) return false;
  if (base.startsWith(".env.")) return false;
  return true;
}

/**
 * Refuses a read of an env file that can hold a secret.
 *
 * @param rel - Project-relative path
 */
export function assertReadable(rel: string): void {
  if (mayReadProjectFile(rel)) return;
  refuseUnsupported("okm init does not read env files.");
}

function existingReal(root: string): string {
  const absolute = resolve(root);
  if (!existsSync(absolute)) refuseUnsupported("okm init needs a directory it can write.");
  return realpathSync(absolute);
}

function assertInside(rootReal: string, target: string): void {
  const rel = relative(rootReal, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  refuseUnsupported("A path escapes the project directory.");
}
