/**
 * Fails when a packed file is not tracked by git.
 *
 * `dist/` is build output and is not committed. Every other path in the
 * tarball must be in `git ls-files`. `--release` also fails when the worktree
 * is dirty, including untracked files.
 *
 *   bun ./scripts/pack-tracked.ts
 *   bun ./scripts/pack-tracked.ts --release
 *   bun ./scripts/pack-tracked.ts --root <dir>
 */

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./root.js";

const release = process.argv.includes("--release");
const rootFlag = process.argv.indexOf("--root");
const rootArg = rootFlag === -1 ? repoRoot() : process.argv[rootFlag + 1];
if (rootArg === undefined || rootArg.length === 0) {
  console.error("pack-tracked: --root needs a directory");
  process.exit(1);
}
const root: string = rootArg;

if (release) {
  const status = await git(["status", "--porcelain", "--untracked-files=all"]);
  if (status.length > 0) {
    console.error("pack-tracked: the worktree is not clean");
    console.error(status);
    process.exit(1);
  }
}

const before = new Set(readdirSync(root).filter((name) => name.endsWith(".tgz")));
const packed = Bun.spawn(["bun", "pm", "pack"], {
  cwd: root,
  stdout: "pipe",
  stderr: "inherit",
});
const stdout = await new Response(packed.stdout).text();
const packCode = await packed.exited;
if (packCode !== 0) process.exit(packCode);

const printed = stdout
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.endsWith(".tgz"))
  .at(-1);
const created = readdirSync(root).find((name) => name.endsWith(".tgz") && !before.has(name));
const name = printed ?? created;
if (name === undefined) {
  console.error("pack-tracked: bun pm pack did not write a tarball");
  process.exit(1);
}

const tarball = join(root, name);
let entries: readonly string[] = [];
try {
  const listed = Bun.spawn(["tar", "-tzf", tarball], { stdout: "pipe", stderr: "inherit" });
  const text = await new Response(listed.stdout).text();
  const code = await listed.exited;
  if (code !== 0) process.exit(code);
  entries = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith("/"));
} finally {
  rmSync(tarball, { force: true });
}

const tracked = new Set(
  (await git(["ls-files"]))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0),
);

const stray: string[] = [];
for (const entry of entries) {
  const path = packedPath(entry);
  if (path === undefined || path.startsWith("dist/")) continue;
  if (!tracked.has(path)) stray.push(path);
}

if (stray.length > 0) {
  console.error("pack-tracked: tarball contains files git does not track");
  for (const path of stray) console.error(`  ${path}`);
  process.exit(1);
}

/**
 * Runs git in the package root.
 *
 * @param args - Git arguments
 * @returns Trimmed stdout
 */
async function git(args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "inherit" });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
  return text.trim();
}

/**
 * Drops the `package/` prefix `npm pack` puts on every member.
 *
 * @param entry - A path from `tar -tzf`
 * @returns The path inside the package, or `undefined` for the root directory
 */
function packedPath(entry: string): string | undefined {
  const slash = entry.indexOf("/");
  if (slash === -1) return undefined;
  const path = entry.slice(slash + 1);
  return path.length === 0 ? undefined : path;
}
