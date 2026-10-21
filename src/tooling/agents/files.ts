/**
 * The files `okm agents` may read and write.
 *
 * Content comes from this package on disk, never from the network or the
 * project. The writable paths are a closed list: `AGENTS.md`, `CLAUDE.md`,
 * the shipped skill files under two fixed directories, and `.okm/init.json`.
 * Nothing else is writable, including `.claude/settings*.json`, hooks,
 * `.vscode/tasks.json`, `.cursor/rules`, and MCP entries.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

import { OkmError } from "../../contracts/error.js";
import { packageRoot } from "../cli/version.js";
import { resolveInside } from "../init/paths.js";
import { refuseContent, refusePath } from "./guards.js";

/** One tool whose skills directory `okm` can fill. */
export type AgentTarget = "claude" | "agents";

/** Targets in the order they are listed and written. */
export const AGENT_TARGETS: readonly AgentTarget[] = ["claude", "agents"];

/** Where the skill goes for each target. */
export const SKILL_DIRS: Readonly<Record<AgentTarget, string>> = {
  claude: ".claude/skills/okmodel",
  agents: ".agents/skills/okmodel",
};

/** The tool directory whose presence selects a target without a flag. */
export const TOOL_DIRS: Readonly<Record<AgentTarget, string>> = {
  claude: ".claude",
  agents: ".agents",
};

/** The agent instruction file. */
export const AGENTS_FILE = "AGENTS.md";

/** The Claude Code import file. */
export const CLAUDE_FILE = "CLAUDE.md";

/** The record file. It holds the hashes of what was written. */
export const RECORD_FILE = ".okm/init.json";

/** One file shipped in `skills/okmodel/`. */
export type SkillFile = {
  /** Path inside the skill directory. */
  readonly rel: string;
  /** File text. */
  readonly text: string;
};

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Files the package ships for the agent skill.
 *
 * Only markdown files are accepted. A symlink, a script, a file with a
 * hidden character, or an empty directory is refused.
 *
 * @param root - Package root. The default is the installed package
 * @returns Files sorted by path
 * @throws OkmError OKM1885 when the content is missing or unsafe
 */
export function shippedSkill(root: string = packageRoot()): readonly SkillFile[] {
  const base = join(root, "skills", "okmodel");
  if (!existsSync(base)) refuseContent("The package has no skills/okmodel directory to copy.");
  const files: SkillFile[] = [];
  walk(base, "", files);
  if (files.length === 0) refuseContent("skills/okmodel in the package has no files to copy.");
  return files.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
}

/**
 * First code point that no agent file may contain.
 *
 * Controls other than tab, newline, and carriage return, bidirectional
 * overrides, zero-width characters, variation selectors, and tag
 * characters are refused.
 *
 * @param text - File text
 * @returns The code point, or `undefined` when the text is clean
 */
export function hiddenCodePoint(text: string): number | undefined {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return code;
    if (code === 0x7f || code === 0xad || code === 0x061c || code === 0x180e) return code;
    if (code >= 0x200b && code <= 0x200f) return code;
    if (code >= 0x2028 && code <= 0x202e) return code;
    if (code >= 0x2060 && code <= 0x206f) return code;
    if (code >= 0xfe00 && code <= 0xfe0f) return code;
    if (code === 0xfeff || (code >= 0xfff9 && code <= 0xfffb)) return code;
    if (code >= 0xe0000 && code <= 0xe01ef) return code;
  }
  return undefined;
}

/**
 * Whether `rel` is one skill path a record may name: a markdown file inside
 * one of the two skill directories.
 *
 * @param rel - Project-relative POSIX path
 * @returns The target and the path inside it, or `undefined`
 */
export function skillPathOf(
  rel: string,
): { readonly target: AgentTarget; readonly inner: string } | undefined {
  for (const target of AGENT_TARGETS) {
    const prefix = `${SKILL_DIRS[target]}/`;
    if (!rel.startsWith(prefix)) continue;
    const inner = rel.slice(prefix.length);
    const parts = inner.split("/");
    const last = parts.at(-1) ?? "";
    if (parts.every((part) => SEGMENT.test(part)) && SKILL_NAME.test(last)) {
      return { target, inner };
    }
  }
  return undefined;
}

/**
 * Every path one run may write.
 *
 * @param skill - Shipped skill files
 * @param targets - Skill targets in play
 * @param extra - Recorded skill paths that may be deleted
 * @returns A set of project-relative paths
 */
export function agentsAllowlist(
  skill: readonly SkillFile[],
  targets: readonly AgentTarget[],
  extra: readonly string[] = [],
): ReadonlySet<string> {
  const allowed = new Set<string>([AGENTS_FILE, CLAUDE_FILE, RECORD_FILE]);
  for (const target of targets) {
    for (const file of skill) allowed.add(`${SKILL_DIRS[target]}/${file.rel}`);
  }
  for (const path of extra) if (skillPathOf(path) !== undefined) allowed.add(path);
  return allowed;
}

/**
 * Absolute path of an allowlisted file that stays inside the project.
 *
 * @param root - Project directory
 * @param rel - Project-relative path
 * @param allowed - The closed list for this run
 * @returns The path to read or write
 * @throws OkmError OKM1886 when the path is not listed or leaves the project
 */
export function agentPath(root: string, rel: string, allowed: ReadonlySet<string>): string {
  if (!allowed.has(rel)) refusePath(`${rel} is not a file okm agents may write.`);
  let path: string;
  try {
    path = resolveInside(root, rel);
  } catch (error) {
    if (error instanceof OkmError) refusePath(`${rel} resolves outside the project directory.`);
    throw error;
  }
  const landed = relative(realpathSync(root), path).split(sep).join("/");
  if (!allowed.has(landed))
    refusePath(`${rel} is a link to ${landed}, which okm agents may not write.`);
  if (existsSync(path) && !lstatSync(path).isFile()) refusePath(`${rel} is not a regular file.`);
  return path;
}

/**
 * Text of one allowlisted file.
 *
 * @param root - Project directory
 * @param rel - Project-relative path
 * @param allowed - The closed list for this run
 * @returns The text, or `undefined` when the file is absent
 */
export function readAgentFile(
  root: string,
  rel: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  const path = agentPath(root, rel, allowed);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * Writes a file by creating a temporary file beside it and renaming it.
 * The mode of an existing file is kept.
 *
 * @param path - Absolute path from {@link agentPath}
 * @param text - New file text
 */
export function writeAtomic(path: string, text: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(path)}.okm-${String(process.pid)}-${tick()}.tmp`);
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  const fd = openSync(temp, "wx", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Deletes a file, then its directory when that directory is now empty.
 *
 * @param path - Absolute path from {@link agentPath}
 * @param directory - Whether to try the parent directory
 */
export function deleteFile(path: string, directory: boolean): void {
  unlinkSync(path);
  if (!directory) return;
  try {
    if (readdirSync(dirname(path)).length === 0) rmdirSync(dirname(path));
  } catch {
    // A directory that is not empty or already gone stays as it is.
  }
}

let counter = 0;

function tick(): string {
  counter += 1;
  return `${Date.now().toString(36)}${String(counter)}`;
}

function walk(base: string, rel: string, out: SkillFile[]): void {
  const dir = rel.length === 0 ? base : join(base, rel);
  for (const name of readdirSync(dir).sort()) {
    const inner = rel.length === 0 ? name : `${rel}/${name}`;
    const full = join(base, inner);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink())
      refuseContent(`skills/okmodel/${inner} in the package is a symlink.`);
    if (stat.isDirectory()) {
      if (!SEGMENT.test(name)) refuseContent(`skills/okmodel/${inner} has an unexpected name.`);
      walk(base, inner, out);
      continue;
    }
    if (!stat.isFile() || !SKILL_NAME.test(name)) {
      refuseContent(`skills/okmodel/${inner} in the package is not a markdown file.`);
    }
    const text = readFileSync(full, "utf8");
    const hidden = hiddenCodePoint(text);
    if (hidden !== undefined) {
      refuseContent(
        `skills/okmodel/${inner} in the package has a hidden character, U+${hidden.toString(16).toUpperCase().padStart(4, "0")}.`,
      );
    }
    out.push({ rel: inner, text });
  }
}
