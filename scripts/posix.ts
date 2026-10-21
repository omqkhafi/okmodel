/**
 * Path helpers whose results do not depend on the host separator.
 *
 * Baselines, reports, and comparisons use forward slashes on Windows and POSIX.
 */

import { relative, sep } from "node:path";

/**
 * `relative` with forward slashes.
 *
 * @param from - Directory or file the result is relative to
 * @param to - Target path
 * @returns A forward-slash relative path
 */
export function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}
