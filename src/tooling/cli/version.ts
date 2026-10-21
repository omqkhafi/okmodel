/**
 * Package version `okm` prints.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Version field of the root `package.json`.
 *
 * The file is found by walking up from this module. A split chunk under
 * `dist/tooling/shared/` and the source file under `src/tooling/cli/` both
 * reach it.
 *
 * @returns The version string
 */
export function readPackageVersion(): string {
  const path = join(packageRoot(), "package.json");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || typeof parsed.version !== "string") {
    throw new Error(`No string version in ${path}`);
  }
  return parsed.version;
}

/**
 * Directory that holds the `okmodel` package.json.
 *
 * A split chunk under `dist/tooling/shared/` and a source file both reach it.
 *
 * @returns The package root
 */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (isRecord(parsed) && parsed.name === "okmodel") return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("okmodel package.json was not found.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
