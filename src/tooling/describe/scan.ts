/**
 * Finds static `raw()` calls without the TypeScript compiler.
 *
 * The scan understands comments, strings, template literals, regex literals,
 * and JSX text well enough not to treat those as calls. A call counts when
 * its callee is a value import of `raw` from `okmodel/pg`, including
 * `import { raw as q }`. The SQL argument must be a string or a template
 * with no substitutions.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { OkmError } from "../../contracts/error.js";
import { normaliseRawSql, rawStatementKey } from "../../dialects/pg/raw-key.js";
import { attachCliDetail } from "../errors/shape.js";
import { rawKind, type RawKind } from "./kind.js";

/** One static call. `exact` is the literal's value, before normalisation. */
export type RawCall = {
  readonly file: string;
  readonly line: number;
  readonly exact: string;
  readonly normalised: string;
  readonly key: string;
  readonly kind: RawKind;
};

/** Default globs when `raw.include` is omitted. */
export const DEFAULT_RAW_INCLUDE = ["src/**/*.{ts,tsx,mts}"] as const;

const SKIP_DIRS = new Set(["node_modules", "dist", ".okm", ".git"]);
const RAW_MODULE = "okmodel/pg";

const OP_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "else",
  "do",
  "typeof",
  "void",
  "delete",
  "await",
  "new",
  "yield",
  "in",
  "of",
  "instanceof",
  "extends",
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "class",
  "var",
  "let",
  "const",
  "import",
  "export",
  "default",
  "break",
  "continue",
  "debugger",
  "with",
  "async",
  "type",
  "interface",
  "enum",
  "namespace",
  "declare",
  "abstract",
  "public",
  "private",
  "protected",
  "readonly",
]);

type Token = {
  readonly kind: "ident" | "string" | "template" | "punct";
  readonly text: string;
  readonly index: number;
};

/**
 * Source files the include globs name.
 *
 * `node_modules`, `dist`, and `.okm` are never walked. Paths are relative to
 * `cwd` and use `/`.
 *
 * @param cwd - Project directory
 * @param include - Globs. Omitted uses {@link DEFAULT_RAW_INCLUDE}
 * @returns Relative paths, sorted
 */
export function listRawSources(cwd: string, include?: readonly string[]): readonly string[] {
  const patterns = expandBraces(include ?? DEFAULT_RAW_INCLUDE).map(globToRegExp);
  const found: string[] = [];
  walk(cwd, cwd, patterns, found);
  found.sort();
  return found;
}

/**
 * Static `raw()` calls in `files`.
 *
 * @param files - Path and source. The path is the location the error names
 * @returns Calls in file order, then source order
 * @throws OkmError OKM1603 when the SQL argument is not a static literal
 * @throws OkmError OKM1602 when the statement cannot be classified
 */
export function discoverRawCalls(
  files: readonly { path: string; text: string }[],
): readonly RawCall[] {
  const calls: RawCall[] = [];
  for (const file of files) calls.push(...callsInFile(file.path, file.text));
  return calls;
}

/**
 * Reads the included sources and returns their static calls.
 *
 * @param cwd - Project directory
 * @param include - Globs. Omitted uses the default
 * @returns The calls
 */
export function discoverProjectRaw(cwd: string, include?: readonly string[]): readonly RawCall[] {
  const files = listRawSources(cwd, include).map((path) => ({
    path,
    text: readFileSync(join(cwd, path), "utf8"),
  }));
  return discoverRawCalls(files);
}

function callsInFile(path: string, text: string): readonly RawCall[] {
  const jsx = path.endsWith(".tsx");
  const tokens = tokenize(text, jsx);
  const names = importedRaw(tokens);
  if (names.size === 0) return [];
  const calls: RawCall[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.kind !== "ident" || !names.has(token.text)) continue;
    if (isMember(tokens, index)) continue;
    const paren = callParen(tokens, index);
    if (paren === undefined) continue;
    const split = splitArgs(tokens, paren + 1);
    const sql = split.args[1];
    if (sql === undefined || !isStaticSql(sql)) {
      throw staticString(path, lineAt(text, token.index));
    }
    const literal = sql[0];
    if (literal === undefined) throw staticString(path, lineAt(text, token.index));
    const exact = literal.text;
    const normalised = normaliseRawSql(exact);
    calls.push({
      file: path,
      line: lineAt(text, token.index),
      exact,
      normalised,
      key: rawStatementKey(exact),
      kind: rawKind(normalised),
    });
    index = split.end;
  }
  return calls;
}

function isStaticSql(tokens: readonly Token[]): boolean {
  if (tokens.length !== 1) return false;
  const token = tokens[0];
  if (token === undefined) return false;
  return token.kind === "string" || token.kind === "template";
}

function staticString(file: string, line: number): OkmError {
  return attachCliDetail(
    new OkmError("OKM1603", `raw SQL must be a static string (${file}:${String(line)}).`, {
      fix: {
        summary: "Pass a string literal or a template literal with no substitutions as the SQL.",
      },
    }),
    { location: { file, line } },
  );
}

function importedRaw(tokens: readonly Token[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.kind !== "ident" || token.text !== "import") continue;
    const next = tokens[index + 1];
    if (next?.kind === "punct" && (next.text === "(" || next.text === ".")) continue;
    const bound = readImport(tokens, index + 1);
    if (bound === undefined) continue;
    for (const name of bound.names) names.add(name);
    index = bound.end;
  }
  return names;
}

function readImport(
  tokens: readonly Token[],
  start: number,
): { readonly names: readonly string[]; readonly end: number } | undefined {
  let index = start;
  let typeOnly = false;
  const first = tokens[index];
  if (first?.kind === "ident" && first.text === "type") {
    const after = tokens[index + 1];
    if (after?.kind === "punct" && after.text === "{") {
      typeOnly = true;
      index += 1;
    } else if (after?.kind === "ident" && after.text !== "from") {
      return undefined;
    }
  }
  const names: string[] = [];
  const head = tokens[index];
  if (head?.kind === "ident") index += 1;
  if (tokens[index]?.kind === "punct" && tokens[index]?.text === ",") index += 1;
  if (tokens[index]?.kind === "punct" && tokens[index]?.text === "*") {
    index += 1;
    if (tokens[index]?.kind === "ident" && tokens[index]?.text === "as") index += 2;
  }
  if (tokens[index]?.kind === "punct" && tokens[index]?.text === "{") {
    index += 1;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token?.kind === "punct" && token.text === "}") {
        index += 1;
        break;
      }
      let specifierType = typeOnly;
      if (token?.kind === "ident" && token.text === "type") {
        specifierType = true;
        index += 1;
      }
      const imported = tokens[index];
      if (imported?.kind !== "ident") return undefined;
      let local = imported.text;
      index += 1;
      if (tokens[index]?.kind === "ident" && tokens[index]?.text === "as") {
        const alias = tokens[index + 1];
        if (alias?.kind !== "ident") return undefined;
        local = alias.text;
        index += 2;
      }
      if (!specifierType && imported.text === "raw") names.push(local);
      if (tokens[index]?.kind === "punct" && tokens[index]?.text === ",") index += 1;
    }
  }
  if (tokens[index]?.kind === "ident" && tokens[index]?.text === "from") index += 1;
  const specifier = tokens[index];
  if (specifier?.kind !== "string" || specifier.text !== RAW_MODULE)
    return { names: [], end: index };
  if (typeOnly) return { names: [], end: index };
  return { names, end: index };
}

function isMember(tokens: readonly Token[], index: number): boolean {
  const previous = tokens[index - 1];
  return previous?.kind === "punct" && previous.text === ".";
}

function callParen(tokens: readonly Token[], index: number): number | undefined {
  let cursor = index + 1;
  const next = tokens[cursor];
  if (next?.kind === "punct" && next.text === "?") {
    const dot = tokens[cursor + 1];
    if (dot?.kind !== "punct" || dot.text !== ".") return undefined;
    cursor += 2;
  }
  const paren = tokens[cursor];
  if (paren?.kind === "punct" && paren.text === "(") return cursor;
  return undefined;
}

function splitArgs(
  tokens: readonly Token[],
  start: number,
): { readonly args: readonly (readonly Token[])[]; readonly end: number } {
  const args: Token[][] = [];
  let current: Token[] = [];
  let depth = 1;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) break;
    if (token.kind === "punct" && depth === 1 && token.text === ",") {
      args.push(current);
      current = [];
      continue;
    }
    if (
      token.kind === "punct" &&
      (token.text === "(" || token.text === "[" || token.text === "{")
    ) {
      depth += 1;
    } else if (
      token.kind === "punct" &&
      (token.text === ")" || token.text === "]" || token.text === "}")
    ) {
      depth -= 1;
      if (depth === 0) {
        if (current.length > 0 || args.length > 0) args.push(current);
        return { args, end: index };
      }
    }
    current.push(token);
  }
  return { args, end: tokens.length - 1 };
}

function tokenize(source: string, jsx: boolean): readonly Token[] {
  const tokens: Token[] = [];
  lex(source, 0, source.length, tokens, jsx, 0);
  return tokens;
}

function lex(
  source: string,
  start: number,
  end: number,
  tokens: Token[],
  jsx: boolean,
  stopBrace: number,
): number {
  let index = start;
  let canRegex = true;
  let brace = 0;
  while (index < end) {
    const char = source[index] ?? "";
    if (isSpace(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) return end;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close === -1 ? end : close + 2;
      continue;
    }
    if (jsx && canRegex && char === "<" && jsxAt(source, index)) {
      index = skipJsxElement(source, index, tokens, jsx);
      canRegex = false;
      continue;
    }
    if (canRegex && char === "/" && source[index + 1] !== "=") {
      index = skipRegex(source, index + 1);
      canRegex = false;
      continue;
    }
    if (char === "'" || char === '"') {
      const read = readQuoted(source, index + 1, char);
      tokens.push({ kind: "string", text: read.value, index });
      index = read.index;
      canRegex = false;
      continue;
    }
    if (char === "`") {
      const read = readTemplate(source, index + 1, tokens, jsx);
      if (read.substitutions) {
        index = read.index;
        canRegex = false;
        continue;
      }
      tokens.push({ kind: "template", text: read.value, index });
      index = read.index;
      canRegex = false;
      continue;
    }
    if (isIdentStart(char)) {
      const word = readIdent(source, index);
      tokens.push({ kind: "ident", text: word, index });
      index += word.length;
      canRegex = OP_KEYWORDS.has(word);
      continue;
    }
    if (isDigit(char) || (char === "." && isDigit(source[index + 1] ?? ""))) {
      index = skipNumber(source, index);
      canRegex = false;
      continue;
    }
    tokens.push({ kind: "punct", text: char, index });
    index += 1;
    if (char === "{") brace += 1;
    if (char === "}") {
      brace -= 1;
      if (stopBrace > 0 && brace < 0) return index;
    }
    canRegex = char !== ")" && char !== "]" && char !== "}" && char !== ".";
  }
  return index;
}

function jsxAt(source: string, index: number): boolean {
  const next = source[index + 1] ?? "";
  return next === ">" || next === "/" || isIdentStart(next);
}

function skipJsxElement(source: string, index: number, tokens: Token[], jsx: boolean): number {
  let cursor = index + 1;
  if (source[cursor] === ">") return skipJsxChildren(source, cursor + 1, tokens, jsx);
  while (cursor < source.length && /[\w$.-]/.test(source[cursor] ?? "")) cursor += 1;
  while (cursor < source.length) {
    const char = source[cursor] ?? "";
    if (isSpace(char)) {
      cursor += 1;
      continue;
    }
    if (char === "/" && source[cursor + 1] === ">") return cursor + 2;
    if (char === ">") return skipJsxChildren(source, cursor + 1, tokens, jsx);
    if (char === "{") {
      cursor = lex(source, cursor + 1, source.length, tokens, jsx, 1);
      continue;
    }
    if (char === "'" || char === '"') {
      cursor = readQuoted(source, cursor + 1, char).index;
      continue;
    }
    cursor += 1;
  }
  return cursor;
}

function skipJsxChildren(source: string, index: number, tokens: Token[], jsx: boolean): number {
  let cursor = index;
  while (cursor < source.length) {
    const char = source[cursor] ?? "";
    if (char === "{") {
      cursor = lex(source, cursor + 1, source.length, tokens, jsx, 1);
      continue;
    }
    if (char === "<" && source[cursor + 1] === "/") {
      const close = source.indexOf(">", cursor + 2);
      return close === -1 ? source.length : close + 1;
    }
    if (char === "<") {
      cursor = skipJsxElement(source, cursor, tokens, jsx);
      continue;
    }
    cursor += 1;
  }
  return cursor;
}

function skipRegex(source: string, index: number): number {
  let cursor = index;
  let inClass = false;
  while (cursor < source.length) {
    const char = source[cursor] ?? "";
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "\n") return cursor;
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      cursor += 1;
      while (cursor < source.length && /[a-z]/i.test(source[cursor] ?? "")) cursor += 1;
      return cursor;
    }
    cursor += 1;
  }
  return cursor;
}

function readQuoted(
  source: string,
  index: number,
  quote: string,
): { readonly value: string; readonly index: number } {
  let cursor = index;
  let value = "";
  while (cursor < source.length) {
    const char = source[cursor] ?? "";
    if (char === "\\") {
      const escaped = decodeEscape(source, cursor + 1);
      value += escaped.value;
      cursor = escaped.index;
      continue;
    }
    if (char === quote) return { value, index: cursor + 1 };
    if (char === "\n") return { value, index: cursor };
    value += char;
    cursor += 1;
  }
  return { value, index: cursor };
}

function readTemplate(
  source: string,
  index: number,
  tokens: Token[],
  jsx: boolean,
): { readonly value: string; readonly index: number; readonly substitutions: boolean } {
  let cursor = index;
  let value = "";
  while (cursor < source.length) {
    const char = source[cursor] ?? "";
    if (char === "\\") {
      const escaped = decodeEscape(source, cursor + 1);
      value += escaped.value;
      cursor = escaped.index;
      continue;
    }
    if (char === "`") return { value, index: cursor + 1, substitutions: false };
    if (char === "$" && source[cursor + 1] === "{") {
      const after = lex(source, cursor + 2, source.length, tokens, jsx, 1);
      const rest = readTemplate(source, after, tokens, jsx);
      return { value: "", index: rest.index, substitutions: true };
    }
    value += char;
    cursor += 1;
  }
  return { value, index: cursor, substitutions: false };
}

function decodeEscape(
  source: string,
  index: number,
): { readonly value: string; readonly index: number } {
  const char = source[index] ?? "";
  if (char === "n") return { value: "\n", index: index + 1 };
  if (char === "r") return { value: "\r", index: index + 1 };
  if (char === "t") return { value: "\t", index: index + 1 };
  if (char === "b") return { value: "\b", index: index + 1 };
  if (char === "f") return { value: "\f", index: index + 1 };
  if (char === "v") return { value: "\v", index: index + 1 };
  if (char === "0") return { value: "\0", index: index + 1 };
  if (char === "\n") return { value: "", index: index + 1 };
  if (char === "\r") {
    const next = source[index + 1] === "\n" ? index + 2 : index + 1;
    return { value: "", index: next };
  }
  if (char === "x") {
    const hex = source.slice(index + 1, index + 3);
    return { value: String.fromCharCode(Number.parseInt(hex, 16)), index: index + 3 };
  }
  if (char === "u" && source[index + 1] === "{") {
    const close = source.indexOf("}", index + 2);
    const hex = source.slice(index + 2, close);
    return { value: String.fromCodePoint(Number.parseInt(hex, 16)), index: close + 1 };
  }
  if (char === "u") {
    const hex = source.slice(index + 1, index + 5);
    return { value: String.fromCharCode(Number.parseInt(hex, 16)), index: index + 5 };
  }
  return { value: char, index: index + 1 };
}

function readIdent(source: string, index: number): string {
  let cursor = index + 1;
  while (cursor < source.length && isIdentCont(source[cursor] ?? "")) cursor += 1;
  return source.slice(index, cursor);
}

function skipNumber(source: string, index: number): number {
  let cursor = index;
  if (source[cursor] === "0" && /[xXoObB]/.test(source[cursor + 1] ?? "")) cursor += 2;
  while (cursor < source.length && /[0-9a-fA-F_.]/.test(source[cursor] ?? "")) cursor += 1;
  if (source[cursor] === "n") cursor += 1;
  return cursor;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < source.length; cursor += 1) {
    if (source[cursor] === "\n") line += 1;
  }
  return line;
}

function walk(cwd: string, dir: string, patterns: readonly RegExp[], found: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(cwd, path, patterns, found);
      continue;
    }
    if (!entry.isFile()) {
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
    }
    const rel = relative(cwd, path).split(sep).join("/");
    if (patterns.some((pattern) => pattern.test(rel))) found.push(rel);
  }
}

function expandBraces(patterns: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    const match = /\{([^{}]+)\}/.exec(pattern);
    if (match === null || match[1] === undefined || match.index === undefined) {
      out.push(pattern);
      continue;
    }
    const prefix = pattern.slice(0, match.index);
    const suffix = pattern.slice(match.index + match[0].length);
    for (const part of match[1].split(",")) out.push(`${prefix}${part.trim()}${suffix}`);
  }
  return out;
}

function globToRegExp(pattern: string): RegExp {
  let body = "^";
  let index = 0;
  while (index < pattern.length) {
    if (pattern.startsWith("**/", index)) {
      body += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (pattern.startsWith("**", index)) {
      body += ".*";
      index += 2;
      continue;
    }
    const char = pattern[index] ?? "";
    if (char === "*") body += "[^/]*";
    else if (char === "?") body += "[^/]";
    else body += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  return new RegExp(`${body}$`);
}

function isSpace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t" || char === "\f";
}

function isIdentStart(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || char === "_" || char === "$";
}

function isIdentCont(char: string): boolean {
  return isIdentStart(char) || isDigit(char);
}

function isDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}
