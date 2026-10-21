/**
 * Finds `filters()` allowlists in project source, without running it.
 *
 * `table.filters(spec)` checks the spec and returns a parser. It keeps
 * nothing, and the call usually lives in a route file the schema never
 * imports. So `okm check` reads the source the way `okm raw sync` does.
 *
 * A call counts when its receiver is an identifier bound once, anywhere in
 * the scanned files, to `table("name", ...)`. Only literal parts are read:
 * the keys of `allow` and the string elements of `sort`. A spread, a computed
 * key, or a name that is not a literal adds nothing, so a field is never
 * guessed.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  importedNames,
  lineAt,
  listRawSources,
  splitArgs,
  tokenize,
  type Token,
} from "../describe/scan.js";
import type { MigrateConfig } from "./config.js";
import { projectPath } from "./paths.js";

/** One field named in a `filters()` call. */
export type FilterUse = {
  /** Table name as passed to `table()`. */
  readonly table: string;
  /** Field name, as written in the allowlist. */
  readonly field: string;
  /** Which list of the call named the field. */
  readonly list: "allow" | "sort";
  readonly file: string;
  readonly line: number;
};

/**
 * Fields named by the `filters()` calls in one project.
 *
 * `okm check` reads the `raw.include` sources, or `src/**` when it is
 * omitted, plus the schema file and the `tables` directory when they sit
 * outside it.
 *
 * @param cwd - Project directory
 * @param config - Project config
 * @returns One entry per call, field, and list
 */
export function projectFilterUses(cwd: string, config: MigrateConfig): readonly FilterUse[] {
  const extra = [relative(cwd, projectPath(cwd, config.schema)).split("\\").join("/")];
  if (config.tables !== undefined) {
    const directory = projectPath(cwd, config.tables);
    const names = existsSync(directory) ? readdirSync(directory) : [];
    for (const name of names) {
      if (/\.(?:ts|tsx|mts)$/.test(name)) {
        extra.push(relative(cwd, join(directory, name)).split("\\").join("/"));
      }
    }
  }
  const paths = new Set([...listRawSources(cwd, config.raw?.include), ...extra]);
  const files: { path: string; text: string }[] = [];
  for (const path of [...paths].sort()) {
    try {
      files.push({ path, text: readFileSync(join(cwd, path), "utf8") });
    } catch {
      continue;
    }
  }
  return discoverFilterUses(files);
}

/**
 * Fields named by `filters()` calls in `files`.
 *
 * @param files - Path and source
 * @returns One entry per call, field, and list, in file then source order
 */
export function discoverFilterUses(
  files: readonly { readonly path: string; readonly text: string }[],
): readonly FilterUse[] {
  const lexed = files.map((file) => ({
    ...file,
    tokens: tokenize(file.text, file.path.endsWith(".tsx")),
  }));
  const bound = new Map<string, string | null>();
  for (const file of lexed) bindTables(file.tokens, bound);
  const uses: FilterUse[] = [];
  for (const file of lexed) {
    const { tokens } = file;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === undefined || token.kind !== "ident") continue;
      const table = bound.get(token.text);
      if (table === undefined || table === null) continue;
      if (isPunct(tokens[index - 1], ".")) continue;
      if (!isPunct(tokens[index + 1], ".") || !isIdent(tokens[index + 2], "filters")) continue;
      if (!isPunct(tokens[index + 3], "(")) continue;
      const first = splitArgs(tokens, index + 4).args[0];
      if (first === undefined) continue;
      const line = lineAt(file.text, token.index);
      for (const found of readSpec(first)) {
        uses.push({ table, field: found.field, list: found.list, file: file.path, line });
      }
    }
  }
  return uses;
}

function bindTables(tokens: readonly Token[], bound: Map<string, string | null>): void {
  const callees = importedNames(tokens, "table", undefined);
  if (callees.size === 0) return;
  for (let index = 0; index + 4 < tokens.length; index += 1) {
    const name = tokens[index];
    if (name === undefined || name.kind !== "ident") continue;
    if (!isPunct(tokens[index + 1], "=")) continue;
    const callee = tokens[index + 2];
    if (callee === undefined || callee.kind !== "ident" || !callees.has(callee.text)) continue;
    if (isPunct(tokens[index - 1], ".")) continue;
    if (!isPunct(tokens[index + 3], "(")) continue;
    const literal = tokens[index + 4];
    if (literal === undefined || literal.kind !== "string") continue;
    const seen = bound.get(name.text);
    bound.set(name.text, seen === undefined || seen === literal.text ? literal.text : null);
  }
}

function readSpec(
  tokens: readonly Token[],
): readonly { readonly field: string; readonly list: "allow" | "sort" }[] {
  if (!isPunct(tokens[0], "{")) return [];
  const found: { field: string; list: "allow" | "sort" }[] = [];
  for (const entry of splitArgs(tokens, 1).args) {
    const key = entry[0];
    if (key === undefined || (key.kind !== "ident" && key.kind !== "string")) continue;
    if (!isPunct(entry[1], ":")) continue;
    const value = entry.slice(2);
    if (key.text === "allow" && isPunct(value[0], "{")) {
      for (const item of splitArgs(value, 1).args) {
        const field = item[0];
        if (field === undefined || (field.kind !== "ident" && field.kind !== "string")) continue;
        if (isPunct(item[1], ":")) found.push({ field: field.text, list: "allow" });
      }
    } else if (key.text === "sort" && isPunct(value[0], "[")) {
      for (const item of splitArgs(value, 1).args) {
        const field = item[0];
        if (item.length === 1 && field?.kind === "string") {
          found.push({ field: field.text, list: "sort" });
        }
      }
    }
  }
  return found;
}

function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === "punct" && token.text === text;
}

function isIdent(token: Token | undefined, text: string): boolean {
  return token?.kind === "ident" && token.text === text;
}
