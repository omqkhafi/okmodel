/**
 * Strips `workspaces` from the packed manifest and restores it afterwards.
 *
 * The repository root is a Bun workspace, but the published `okmodel`
 * tarball must not carry the `workspaces` field. `bun pm pack` runs the
 * `prepack` script before it packs and `postpack` after, so every pack step
 * (the release workflow, the tarball smoke, `publint`, `attw`) packs the
 * stripped manifest while the root keeps the field.
 *
 *   bun ./scripts/strip-workspaces.ts strip
 *   bun ./scripts/strip-workspaces.ts restore
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { repoRoot } from "./root.js";

/** Backup of the manifest while the stripped copy is packed. Untracked. */
const BACKUP = "package.json.packbak";

/**
 * Removes `workspaces` from `package.json`, keeping a backup to restore.
 *
 * @param root - Repository root
 */
export function stripWorkspaces(root: string): void {
  const manifest = `${root}/package.json`;
  const text = readFileSync(manifest, "utf8");
  renameSync(manifest, `${root}/${BACKUP}`);
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      delete (parsed as Record<string, unknown>)["workspaces"];
    }
    writeFileSync(manifest, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch (error) {
    renameSync(`${root}/${BACKUP}`, manifest);
    throw error;
  }
}

/**
 * Puts the backed-up `package.json` back. A missing backup is a no-op.
 *
 * @param root - Repository root
 */
export function restoreWorkspaces(root: string): void {
  try {
    renameSync(`${root}/${BACKUP}`, `${root}/package.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

if (import.meta.main) {
  const [mode] = process.argv.slice(2);
  if (mode === "strip") stripWorkspaces(repoRoot());
  else if (mode === "restore") restoreWorkspaces(repoRoot());
  else throw new Error("Usage: bun ./scripts/strip-workspaces.ts strip|restore");
}
