/**
 * Paths from this package back to the OKModel repository root.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root (the parent of `site/`). */
export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Absolute path of `site/`. */
export function siteRoot(): string {
  return join(repoRoot(), "site");
}
