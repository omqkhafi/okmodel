import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path of the repository root.
 */
export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}
