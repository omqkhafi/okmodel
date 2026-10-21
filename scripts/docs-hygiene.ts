/**
 * Hygiene for the docs that ship in the tarball.
 *
 * Public pages need front matter. They link only to public pages. A code
 * fence names a language. Packed text has no hidden characters. The index
 * matches `docs-index.ts`. The capabilities page, support blocks, and the
 * step table match `docs-capabilities.ts`. `scripts/readme-check.ts` checks README links.
 * It does not typecheck fences, and this script does not add a second
 * typecheck.
 *
 *   bun ./scripts/docs-hygiene.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { okmMentions } from "../src/tooling/agents/mentions.js";
import {
  classificationProblems,
  docClass,
  docsFiles,
  npmIgnoreText,
  packedTextPaths,
  type DocClass,
} from "./docs-pack.js";
import { capabilityDocProblems } from "./docs-capabilities.js";
import { indexCoverageProblems, indexStaleProblems } from "./docs-index.js";
import { exitOnProblems } from "./report.js";
import { repoRoot } from "./root.js";

/** Extensions scanned for hidden characters. `LICENSE` is included by name. */
const SCANNED_EXTENSIONS = [".md", ".json", ".txt", ".mjs"] as const;

/**
 * Files that may contain ZWNJ or ZWJ inside a word.
 *
 * Empty on purpose. Arabic, Persian, Hebrew, and Indic letters are allowed
 * in every packed text file. The joiners are not, unless a path is listed
 * here and the joiner sits between letters.
 */
export const HIDDEN_CHAR_ALLOWLIST: readonly string[] = [];

const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g;
const URL = /https?:\/\/[^\s)>]+/g;
const FENCE = /^(\s*)```(.*)$/;

const FRONT_VERSION = /^okmVersion:\s*"([^"]+)"$/m;
const FRONT_SINCE = /^since:\s*"([^"]+)"$/m;
const FRONT_DIALECTS = /^dialects:\s*\[([^\]]*)\]$/m;
const FRONT_CODES = /^codes:\s*\[([^\]]*)\]$/m;

/**
 * Every hygiene problem for this repository.
 *
 * @param root - Repository root
 * @param version - Full package version, for the index check
 * @returns Problem lines
 */
export function hygieneProblems(root: string, version: string): readonly string[] {
  return [
    ...classificationProblems(root),
    ...ignoreProblems(root),
    ...indexCoverageProblems(root),
    ...indexStaleProblems(root, version),
    ...capabilityDocProblems(root),
    ...publicPageProblems(root),
    ...hiddenCharProblems(root),
    ...skillProblems(root),
    ...exampleTypecheckProblems(),
  ];
}

/**
 * `readme-check` does not typecheck examples.
 *
 * The handbook fence check is `site/scripts/docs-code.ts`, and it reads the
 * site content directory. Public guides under `docs/` are not that set.
 * This function stays empty so a second typecheck is not invented here.
 *
 * @returns Problem lines. Always empty
 */
export function exampleTypecheckProblems(): readonly string[] {
  return [];
}

/**
 * Front matter, links, fences, and command names on public pages.
 *
 * @param root - Repository root
 * @returns Problem lines
 */
export function publicPageProblems(root: string): readonly string[] {
  const problems: string[] = [];
  for (const rel of docsFiles(root)) {
    if (docClass(rel) !== "public" || !rel.endsWith(".md")) continue;
    const path = `docs/${rel}`;
    const text = readFileSync(join(root, path), "utf8");
    problems.push(...frontMatterProblems(text, path));
    problems.push(...fenceProblems(text, path));
    problems.push(...internalLinkProblems(root, path, text));
  }
  for (const path of ["docs/roles.md", "docs/threat-model.md", "docs/index.md"]) {
    const file = join(root, path);
    if (!existsSync(file)) continue;
    problems.push(...unknownCommandProblems(readFileSync(file, "utf8"), path));
  }
  return problems;
}

/**
 * Hidden characters in the text files the tarball ships.
 *
 * @param root - Repository root
 * @returns Problem lines. One per hit
 */
export function hiddenCharProblems(root: string): readonly string[] {
  const problems: string[] = [];
  for (const rel of packedTextPaths(root)) {
    if (!isScannedText(rel)) continue;
    const text = readFileSync(join(root, rel), "utf8");
    problems.push(...hiddenCharsIn(text, rel, HIDDEN_CHAR_ALLOWLIST.includes(rel)));
  }
  return problems;
}

/**
 * Hidden characters in one string.
 *
 * @param text - File contents
 * @param where - Path printed in each problem
 * @param allowJoiners - Whether ZWNJ and ZWJ between letters are allowed
 * @returns Problem lines
 */
export function hiddenCharsIn(
  text: string,
  where: string,
  allowJoiners: boolean,
): readonly string[] {
  const problems: string[] = [];
  const chars: string[] = [];
  for (let offset = 0; offset < text.length;) {
    const value = text.codePointAt(offset);
    if (value === undefined) break;
    const char = String.fromCodePoint(value);
    chars.push(char);
    offset += char.length;
  }
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === undefined) continue;
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code === 0) {
      problems.push(`${where}: NUL`);
      continue;
    }
    if (isBidiOverride(code) || isTag(code)) {
      problems.push(`${where}: U+${code.toString(16).toUpperCase()}`);
      continue;
    }
    if (isVariation(code)) {
      const previous = chars[index - 1];
      if (previous !== undefined && isEmojiBase(previous) && (code === 0xfe0e || code === 0xfe0f)) {
        continue;
      }
      problems.push(`${where}: variation selector U+${code.toString(16).toUpperCase()}`);
      continue;
    }
    if (!isZeroWidth(code)) continue;
    if (allowJoiners && isJoiner(code) && joinerInsideWord(chars, index)) continue;
    problems.push(`${where}: zero-width U+${code.toString(16).toUpperCase()}`);
  }
  return problems;
}

/**
 * Problems when a public page's front matter is missing a field.
 *
 * @param text - Page source
 * @param where - Path printed in each problem
 * @returns Problem lines
 */
export function frontMatterProblems(text: string, where: string): readonly string[] {
  if (!text.startsWith("---\n")) return [`${where}: missing front matter`];
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return [`${where}: front matter does not close`];
  const body = text.slice(4, end);
  const problems: string[] = [];
  const version = FRONT_VERSION.exec(body);
  const since = FRONT_SINCE.exec(body);
  const dialects = FRONT_DIALECTS.exec(body);
  const codes = FRONT_CODES.exec(body);
  if (version === null || (version[1] ?? "").length === 0)
    problems.push(`${where}: missing okmVersion`);
  if (since === null || (since[1] ?? "").length === 0) problems.push(`${where}: missing since`);
  if (dialects === null || splitList(dialects[1] ?? "").length === 0) {
    problems.push(`${where}: missing dialects`);
  }
  if (codes === null) problems.push(`${where}: missing codes`);
  else {
    for (const code of splitList(codes[1] ?? "")) {
      if (!/^OKM\d{4}$/.test(code)) problems.push(`${where}: code ${code} is not OKM####`);
    }
  }
  return problems;
}

/**
 * Opening fences that name no language.
 *
 * @param text - Page source
 * @param where - Path printed in each problem
 * @returns Problem lines
 */
export function fenceProblems(text: string, where: string): readonly string[] {
  const problems: string[] = [];
  let open = false;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = FENCE.exec(line);
    if (match === null) continue;
    if (!open) {
      const info = (match[2] ?? "").trim();
      if (info.length === 0)
        problems.push(`${where}:${String(index + 1)} code fence has no language`);
      open = true;
    } else {
      open = false;
    }
  }
  return problems;
}

/**
 * Links and URLs from a public page that name an internal doc.
 *
 * @param root - Repository root
 * @param file - Repo-relative markdown path
 * @param text - Page source
 * @returns Problem lines
 */
export function internalLinkProblems(root: string, file: string, text: string): readonly string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const push = (hit: string): void => {
    const line = `${file} links to internal ${hit}`;
    if (seen.has(line)) return;
    seen.add(line);
    problems.push(line);
  };
  for (const match of text.matchAll(LINK)) {
    const url = (match[1] ?? "").trim();
    if (url.length === 0 || url.startsWith("#")) continue;
    const hit = internalTarget(root, file, url);
    if (hit !== undefined) push(hit);
  }
  for (const match of text.matchAll(URL)) {
    const url = match[0] ?? "";
    const hit = internalUrl(url);
    if (hit !== undefined) push(hit);
  }
  return problems;
}

/**
 * `okm` phrases that are not in the command table.
 *
 * @param text - Page source
 * @param where - Path printed in each problem
 * @returns Problem lines
 */
export function unknownCommandProblems(text: string, where: string): readonly string[] {
  const mentions = okmMentions(text);
  return mentions.bad.map((phrase) => `${where}: unknown command okm ${phrase}`.trim());
}

function ignoreProblems(root: string): readonly string[] {
  const path = join(root, "docs/.npmignore");
  if (!existsSync(path)) return ["docs-pack: docs/.npmignore is missing"];
  if (readFileSync(path, "utf8") !== npmIgnoreText()) {
    return ["docs-pack: docs/.npmignore does not match the internal list"];
  }
  return [];
}

function skillProblems(root: string): readonly string[] {
  const path = join(root, "skills/okmodel/SKILL.md");
  if (!existsSync(path)) return ["skill: skills/okmodel/SKILL.md is missing"];
  const text = readFileSync(path, "utf8");
  const problems: string[] = [];
  const lines = text.trimEnd().split("\n");
  if (lines.length > 100) problems.push(`skill: ${String(lines.length)} lines exceeds 100`);
  if (!text.startsWith("---\n")) problems.push("skill: missing front matter");
  const description = text.split("\n").find((line) => line.startsWith("description:"));
  if (description === undefined) problems.push("skill: missing description");
  else {
    for (const word of ["schema", "query", "migration", "OKM", "production"]) {
      if (!description.includes(word)) problems.push(`skill: description does not name ${word}`);
    }
  }
  const reader = readFileSync(join(root, "site/lib/agent-skills.ts"), "utf8");
  if (!reader.includes('join(repoRoot(), "skills/okmodel/SKILL.md")')) {
    problems.push("skill: the site does not read skills/okmodel/SKILL.md");
  }
  const copy = join(root, "site/content/agent-skills/okmodel/SKILL.md");
  if (existsSync(copy) && !readFileSync(copy).equals(readFileSync(path))) {
    problems.push("skill: site copy differs from skills/okmodel/SKILL.md");
  }
  problems.push(...unknownCommandProblems(text, "skills/okmodel/SKILL.md"));
  return problems;
}

function internalTarget(root: string, file: string, url: string): string | undefined {
  const named = internalUrl(url);
  if (named !== undefined) return named;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return undefined;
  const hashAt = url.indexOf("#");
  const pathPart = hashAt === -1 ? url : url.slice(0, hashAt);
  if (pathPart.length === 0) return undefined;
  const absolute = resolve(dirname(join(root, file)), pathPart);
  const docsRoot = join(root, "docs");
  const rel = relative(docsRoot, absolute);
  if (rel.startsWith("..") || rel.length === 0) return undefined;
  const posix = rel.split(sep).join("/");
  const kind: DocClass | undefined = docClass(posix);
  if (kind === "internal") return posix;
  return undefined;
}

function internalUrl(url: string): string | undefined {
  for (const name of [
    "okmodel-decisions.md",
    "okmodel-execution-plan.md",
    "okmodel-api-design.md",
    "okmodel-gap-research.md",
    "m0-findings.md",
    "p100-offline-audit.md",
    "p108-inline-relations-study.md",
    "oke-windows-audit.md",
    "ci-and-test-cycle-plan.md",
    "ci-baseline.md",
    "offline-first-constraints.md",
    "github.md",
    "release.md",
    "size.md",
    "postgresjs-kill-storm.md",
    "postgresjs-kill-storm.mjs",
    "describe-spike.md",
    "editor-check.md",
  ]) {
    if (url.includes(`/${name}`) || url.endsWith(name)) return name;
  }
  return undefined;
}

function splitList(value: string): readonly string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function isScannedText(rel: string): boolean {
  if (rel === "LICENSE" || rel === "README.md") return true;
  return SCANNED_EXTENSIONS.some((extension) => rel.endsWith(extension));
}

function isZeroWidth(code: number): boolean {
  return (
    code === 0x200b ||
    code === 0x200c ||
    code === 0x200d ||
    code === 0x2060 ||
    code === 0x180e ||
    code === 0xfeff
  );
}

function isJoiner(code: number): boolean {
  return code === 0x200c || code === 0x200d;
}

function isBidiOverride(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

function isTag(code: number): boolean {
  return code >= 0xe0000 && code <= 0xe007f;
}

function isVariation(code: number): boolean {
  return (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef);
}

function isEmojiBase(char: string): boolean {
  return /\p{Extended_Pictographic}/u.test(char);
}

function joinerInsideWord(chars: readonly string[], index: number): boolean {
  const previous = chars[index - 1];
  const next = chars[index + 1];
  if (previous === undefined || next === undefined) return false;
  return /\p{L}/u.test(previous) && /\p{L}/u.test(next);
}

function packageVersion(root: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error("docs-hygiene: package.json has no version");
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "string") throw new Error("docs-hygiene: version is not a string");
  return version;
}

if (import.meta.main) {
  exitOnProblems(hygieneProblems(repoRoot(), packageVersion(repoRoot())));
}
