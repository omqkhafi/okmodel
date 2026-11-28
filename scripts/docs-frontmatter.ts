/**
 * Frontmatter lint for handbook pages.
 *
 * A page on {@link FRONTMATTER_EXEMPT} may omit the support fields. Every
 * other page needs `title`, a one-sentence `summary`, `since`, and `status`.
 * `feature` is optional and must be a registry key. A heading or a page that
 * names an unknown key fails. Keys with no page are reported by
 * {@link unmappedFeatures} and do not fail.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { featureReferences, featureRules } from "./docs-support.js";
import { FRONTMATTER_EXEMPT, FRONTMATTER_EXEMPT_CEILING } from "./frontmatter-exempt.js";
import { repoRoot } from "./root.js";

/** Status values a non-exempt page may set. */
export const FRONTMATTER_STATUS = ["stable", "experimental", "deprecated"] as const;

/** Fields the support schema reads. */
export type HandbookFrontmatter = {
  readonly title?: string;
  readonly summary?: string;
  readonly since?: string;
  readonly feature?: string;
  readonly status?: string;
};

const SINCE = /^\d+\.\d+(?:\.\d+)?$/;
const ENGINE_ATTR = /\bengines="([^"]+)"/g;

/**
 * Whether `summary` is one sentence.
 *
 * One terminator, and it is the last character. No line break.
 *
 * @param summary - Frontmatter value
 * @returns True when the value is a single sentence
 */
export function isOneSentence(summary: string): boolean {
  if (summary.length === 0 || summary !== summary.trim() || summary.includes("\n")) return false;
  const marks = summary.match(/[.!?]/g);
  if (marks === null || marks.length !== 1) return false;
  const last = summary[summary.length - 1];
  return last === "." || last === "!" || last === "?";
}

/**
 * Problems in one page's support fields.
 *
 * @param fields - Parsed frontmatter
 * @param where - Path printed in each problem
 * @param keys - Registry keys. A `feature` value must be one of these
 * @param packageVersion - Current package version. When set, `since` may be
 * this minor or the next one, and a malformed value still fails
 * @returns Problem lines. Empty when the page matches the schema
 */
export function frontmatterFieldProblems(
  fields: HandbookFrontmatter,
  where: string,
  keys: ReadonlySet<string>,
  packageVersion?: string,
): readonly string[] {
  const problems: string[] = [];
  if (fields.title === undefined || fields.title.length === 0) {
    problems.push(`${where}: title is required`);
  }
  if (fields.summary === undefined || !isOneSentence(fields.summary)) {
    problems.push(`${where}: summary must be one sentence`);
  }
  if (fields.since === undefined || !SINCE.test(fields.since)) {
    problems.push(`${where}: since must be an okmodel version`);
  } else if (packageVersion !== undefined && !sinceWithinNextMinor(fields.since, packageVersion)) {
    problems.push(`${where}: since must be this minor or the next one`);
  }
  if (
    fields.status === undefined ||
    !(FRONTMATTER_STATUS as readonly string[]).includes(fields.status)
  ) {
    problems.push(`${where}: status must be stable, experimental, or deprecated`);
  }
  if (fields.feature !== undefined && !keys.has(fields.feature)) {
    problems.push(`${where}: feature ${fields.feature} is not a registry key`);
  }
  return problems;
}

/**
 * Read the support fields from a handbook file.
 *
 * @param raw - Full MDX source
 * @returns The fields that were present
 */
export function readHandbookFrontmatter(raw: string): HandbookFrontmatter {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return {};
  const fields: {
    title?: string;
    summary?: string;
    since?: string;
    feature?: string;
    status?: string;
  } = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    const name = match?.[1];
    const value = match?.[2];
    if (name === undefined || value === undefined) continue;
    if (!isSupportField(name)) continue;
    fields[name] = unquote(value.trim());
  }
  return fields;
}

/**
 * Problems for the handbook: exemption growth, schema misses, unknown keys,
 * and unknown engines.
 *
 * @param root - Repository root
 * @returns Problem lines. Empty when the lint passes
 */
export function handbookProblems(root: string = repoRoot()): readonly string[] {
  const problems: string[] = [];
  if (FRONTMATTER_EXEMPT.length > FRONTMATTER_EXEMPT_CEILING) {
    problems.push(
      `docs-frontmatter: exemption list grew past ${String(FRONTMATTER_EXEMPT_CEILING)}`,
    );
  }
  const exempt = new Set<string>(FRONTMATTER_EXEMPT);
  const files = handbookFiles(join(root, "site/content/docs"));
  const seen = new Set(files.map((file) => file.path));
  for (const path of FRONTMATTER_EXEMPT) {
    if (!seen.has(path)) problems.push(`docs-frontmatter: exemption lists missing ${path}`);
  }
  const keys = registryKeys();
  const version = readPackageVersion(root);
  for (const file of files) {
    if (exempt.has(file.path)) continue;
    const fields = readHandbookFrontmatter(file.text);
    for (const problem of frontmatterFieldProblems(fields, file.path, keys, version)) {
      problems.push(`docs-frontmatter: ${problem}`);
    }
  }
  const refs = featureReferences(files, keys);
  for (const item of refs.unknown) {
    problems.push(`docs-frontmatter: ${item.path} names unknown feature ${item.key}`);
  }
  for (const file of files) {
    const body = file.text.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ""));
    for (const match of body.matchAll(ENGINE_ATTR)) {
      const engine = match[1];
      if (engine !== "postgres") {
        problems.push(`docs-frontmatter: ${file.path} names unknown engine ${engine ?? ""}`);
      }
    }
  }
  return problems;
}

/**
 * Registry keys that no page frontmatter and no heading names yet.
 *
 * A list for the report. It is not a failure.
 *
 * @param root - Repository root
 * @returns Keys with no page, in registry order
 */
export function unmappedFeatures(root: string = repoRoot()): readonly string[] {
  const keys = registryKeys();
  const files = handbookFiles(join(root, "site/content/docs"));
  const mapped = featureReferences(files, keys).mapped;
  return [...keys].filter((key) => !mapped.has(key));
}

/**
 * Whether `since` is the package minor or the next minor, or an older one.
 *
 * `0.11` is accepted while the package is `0.10.6`. `soon` never reaches
 * this function. `0.12` is past the next minor and is rejected.
 *
 * @param since - Handbook `since`, already matched as a version
 * @param packageVersion - `package.json` version
 * @returns True when the minor is not past the next release
 */
export function sinceWithinNextMinor(since: string, packageVersion: string): boolean {
  const pkg = /^(\d+)\.(\d+)/.exec(packageVersion);
  const got = /^(\d+)\.(\d+)/.exec(since);
  if (pkg === null || got === null) return false;
  const pkgMajor = Number(pkg[1]);
  const pkgMinor = Number(pkg[2]);
  const gotMajor = Number(got[1]);
  const gotMinor = Number(got[2]);
  if (gotMajor < pkgMajor) return true;
  if (gotMajor > pkgMajor) return false;
  return gotMinor <= pkgMinor + 1;
}

function readPackageVersion(root: string): string | undefined {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) return undefined;
  const version = (parsed as { version?: unknown }).version;
  return typeof version === "string" ? version : undefined;
}

function registryKeys(): ReadonlySet<string> {
  return new Set(Object.keys(featureRules()));
}

function handbookFiles(dir: string): { readonly path: string; readonly text: string }[] {
  const files: { path: string; text: string }[] = [];
  walk(dir, dir, files);
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return files;
}

function walk(root: string, dir: string, files: { path: string; text: string }[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(root, path, files);
      continue;
    }
    if (!name.endsWith(".mdx")) continue;
    const rel = path.slice(root.length + 1);
    files.push({ path: rel, text: readFileSync(path, "utf8") });
  }
}

function isSupportField(name: string): name is keyof HandbookFrontmatter {
  return (
    name === "title" ||
    name === "summary" ||
    name === "since" ||
    name === "feature" ||
    name === "status"
  );
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
