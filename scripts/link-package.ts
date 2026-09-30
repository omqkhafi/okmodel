import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { repoRoot } from "./root.js";

/**
 * Links `node_modules/okmodel` at the repository so exports can be imported by name.
 *
 * The package under test is the repository root. Node and Bun resolve that name
 * from `node_modules`, not from the root `package.json` alone.
 */
export function linkSelfPackage(): void {
  const root = repoRoot();
  const linkPath = join(root, "node_modules", "okmodel");
  mkdirSync(dirname(linkPath), { recursive: true });
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) {
      throw new Error(`${linkPath} exists and is not a symlink`);
    }
    const target = resolve(dirname(linkPath), readlinkSync(linkPath));
    if (target !== root) {
      throw new Error(`${linkPath} points at ${target}`);
    }
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
    symlinkSync(root, linkPath, "dir");
  }
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

if (import.meta.main) {
  linkSelfPackage();
}
