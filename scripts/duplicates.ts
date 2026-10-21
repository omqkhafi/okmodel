/**
 * Reports duplicate or near-duplicate function bodies and repeated large
 * literals under `src/`.
 *
 * A function body is tokenised. Local names become one placeholder, so a
 * renamed copy still matches. A window of {@link DUPLICATE_WINDOW} tokens is
 * hashed, then extended while the tokens stay equal. The whole body is also
 * hashed when it is at least {@link DUPLICATE_FULL_MIN} tokens. A string or
 * template of at least {@link LITERAL_MIN_CHARS} characters is grouped by its
 * text.
 *
 * The minified size is the source with comments and whitespace removed. Names
 * are not mangled, so the number is an upper bound.
 *
 *   bun ./scripts/duplicates.ts
 *
 * The script prints the groups and exits 0. It does not fail the build.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync, Visitor } from "oxc-parser";

import { posixRelative } from "./posix.js";
import { repoRoot } from "./root.js";

/** Tokens in a window that can seed a partial match. */
export const DUPLICATE_WINDOW = 32;

/** Tokens required before a whole function body is compared. */
export const DUPLICATE_FULL_MIN = 24;

/** Characters in a string or template before it is a large literal. */
export const LITERAL_MIN_CHARS = 80;

const SKIP_DIRS = new Set(["node_modules", "dist"]);

const KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "of",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const OPERATORS = [
  "===",
  "!==",
  ">>=",
  "<<=",
  "**=",
  "&&=",
  "||=",
  "??=",
  "...",
  "=>",
  "<=",
  ">=",
  "==",
  "!=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "<<",
  ">>",
  "**",
];

/** One place a duplicate was found. */
export type DuplicateSite = {
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
  readonly name: string;
};

/** A group of matching function bodies or identical large literals. */
export type DuplicateGroup = {
  readonly kind: "function" | "literal";
  /** sha256 prefix of the normalised tokens or the literal text. */
  readonly hash: string;
  /**
   * Whitespace-stripped size of one copy, in bytes.
   *
   * Names are not mangled.
   */
  readonly minifiedBytes: number;
  readonly sites: readonly DuplicateSite[];
};

type RawFn = {
  readonly name: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
};

type Tok = {
  readonly norm: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
};

type Fn = RawFn & {
  readonly file: string;
  readonly source: string;
  readonly tokens: readonly Tok[];
};

type MeasuredSite = {
  readonly site: DuplicateSite;
  readonly bytes: number;
};

type LiteralHit = {
  readonly file: string;
  readonly line: number;
  readonly value: string;
};

/**
 * Duplicate groups under `src/`.
 *
 * @param root - Repository root
 * @returns Groups, largest estimated size first
 */
export function duplicateGroups(root: string): readonly DuplicateGroup[] {
  const functions: Fn[] = [];
  const literals: LiteralHit[] = [];
  for (const file of walkSrc(root)) {
    const absolute = join(root, ...file.split("/"));
    const source = readFileSync(absolute, "utf8");
    const parsed = parseSync(absolute, source, {
      lang: file.endsWith(".tsx") ? "tsx" : "ts",
      sourceType: "module",
    });
    const failure = parsed.errors[0];
    if (failure !== undefined) throw new Error(`${file}: ${failure.message}`);
    const raw: RawFn[] = [];
    const foundLiterals: LiteralHit[] = [];
    const visitor = new Visitor({
      FunctionDeclaration(node) {
        pushFunction(raw, source, node.id?.name ?? "(function)", node.start, node.body);
      },
      FunctionExpression(node) {
        pushFunction(raw, source, node.id?.name ?? "(function)", node.start, node.body);
      },
      ArrowFunctionExpression(node) {
        pushFunction(raw, source, "(arrow)", node.start, node.body);
      },
      Literal(node) {
        if (
          !("value" in node) ||
          typeof node.value !== "string" ||
          node.value.length < LITERAL_MIN_CHARS
        )
          return;
        foundLiterals.push({ file, line: lineAt(source, node.start), value: node.value });
      },
      TemplateLiteral(node) {
        if (node.expressions.length > 0) return;
        const value = node.quasis.map((part) => part.value.cooked ?? part.value.raw).join("");
        if (value.length < LITERAL_MIN_CHARS) return;
        foundLiterals.push({ file, line: lineAt(source, node.start), value });
      },
    });
    visitor.visit(parsed.program);
    for (const fn of raw) {
      const nested = raw.filter(
        (other) => other !== fn && other.start >= fn.start && other.end <= fn.end,
      );
      const tokens = lex(source, fn.start, fn.end, nested);
      if (tokens.length === 0) continue;
      functions.push({ ...fn, file, source, tokens });
    }
    literals.push(...foundLiterals);
  }
  return [...functionGroups(functions), ...literalGroups(literals)].sort(byGroup);
}

/**
 * Text report. Each group lists every site.
 *
 * @param groups - Groups from {@link duplicateGroups}
 * @returns The report, ending in a newline
 */
export function formatDuplicates(groups: readonly DuplicateGroup[]): string {
  const lines = [`duplicates: ${String(groups.length)}`];
  for (const group of groups) {
    const copies = group.kind === "literal" ? ` x${String(group.sites.length)}` : "";
    lines.push(
      `${group.kind} ${group.hash} ~${String(group.minifiedBytes)} minified bytes${copies}`,
    );
    for (const site of group.sites) {
      const span =
        site.endLine === site.line
          ? String(site.line)
          : `${String(site.line)}-${String(site.endLine)}`;
      const name = group.kind === "function" ? ` ${site.name}` : "";
      lines.push(`  ${site.file}:${span}${name}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Byte length after comments and whitespace are removed.
 *
 * @param source - A function body or a literal's surrounding source
 * @returns The estimated minified size
 */
export function estimateMinified(source: string): number {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    const next = source.charCodeAt(index + 1);
    if (code === 47 && next === 47) {
      index += 2;
      while (index < source.length && source.charCodeAt(index) !== 10) index += 1;
      continue;
    }
    if (code === 47 && next === 42) {
      index += 2;
      while (
        index < source.length &&
        !(source.charCodeAt(index) === 42 && source.charCodeAt(index + 1) === 47)
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (code === 34 || code === 39 || code === 96) {
      const end = scanString(source, index);
      out += source.slice(index, end);
      index = end;
      continue;
    }
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 12) {
      index += 1;
      continue;
    }
    out += source.charAt(index);
    index += 1;
  }
  return out.length;
}

function functionGroups(functions: readonly Fn[]): readonly DuplicateGroup[] {
  const full = new Map<string, Fn[]>();
  for (const fn of functions) {
    if (fn.tokens.length < DUPLICATE_FULL_MIN) continue;
    const id = digest(tokenText(fn.tokens, 0, fn.tokens.length));
    const list = full.get(id) ?? [];
    list.push(fn);
    full.set(id, list);
  }
  const consumed = new Set<string>();
  const groups: DuplicateGroup[] = [];
  for (const [hash, list] of full) {
    if (list.length < 2) continue;
    for (let left = 0; left < list.length; left += 1) {
      for (let right = left + 1; right < list.length; right += 1) {
        consumed.add(pairKey(list[left]!, list[right]!));
      }
    }
    groups.push(
      groupFrom(
        hash,
        list.map((fn) => measure(fn, 0, fn.tokens.length)),
      ),
    );
  }
  const windows = new Map<string, { fn: Fn; at: number }[]>();
  for (const fn of functions) {
    if (fn.tokens.length < DUPLICATE_WINDOW) continue;
    for (let index = 0; index <= fn.tokens.length - DUPLICATE_WINDOW; index += 1) {
      const id = digest(tokenText(fn.tokens, index, index + DUPLICATE_WINDOW));
      const list = windows.get(id) ?? [];
      list.push({ fn, at: index });
      windows.set(id, list);
    }
  }
  const best = new Map<
    string,
    { left: Fn; right: Fn; leftAt: number; leftEnd: number; rightAt: number; rightEnd: number }
  >();
  for (const hits of windows.values()) {
    if (hits.length < 2 || hits.length > 30) continue;
    for (let left = 0; left < hits.length; left += 1) {
      for (let right = left + 1; right < hits.length; right += 1) {
        const a = hits[left]!;
        const b = hits[right]!;
        if (a.fn === b.fn || overlaps(a.fn, b.fn)) continue;
        if (consumed.has(pairKey(a.fn, b.fn))) continue;
        const span = extend(a.fn, a.at, b.fn, b.at);
        const key = pairKey(a.fn, b.fn);
        const previous = best.get(key);
        if (
          previous === undefined ||
          span.leftEnd - span.leftAt > previous.leftEnd - previous.leftAt
        ) {
          best.set(key, { left: a.fn, right: b.fn, ...span });
        }
      }
    }
  }
  const partial = new Map<string, MeasuredSite[]>();
  for (const span of best.values()) {
    if (span.leftEnd - span.leftAt < DUPLICATE_WINDOW) continue;
    const hash = digest(tokenText(span.left.tokens, span.leftAt, span.leftEnd));
    if (full.has(hash) && (full.get(hash)?.length ?? 0) >= 2) continue;
    const sites = partial.get(hash) ?? [];
    sites.push(
      measure(span.left, span.leftAt, span.leftEnd),
      measure(span.right, span.rightAt, span.rightEnd),
    );
    partial.set(hash, sites);
  }
  for (const [hash, sites] of partial) {
    const group = groupFrom(hash, sites);
    if (group.sites.length < 2) continue;
    groups.push(group);
  }
  return groups;
}

function literalGroups(literals: readonly LiteralHit[]): readonly DuplicateGroup[] {
  const grouped = new Map<string, LiteralHit[]>();
  for (const hit of literals) {
    const list = grouped.get(hit.value) ?? [];
    list.push(hit);
    grouped.set(hit.value, list);
  }
  const groups: DuplicateGroup[] = [];
  for (const [value, hits] of grouped) {
    const sites = dedupeSites(
      hits.map((hit) => ({ file: hit.file, line: hit.line, endLine: hit.line, name: "" })),
    );
    if (sites.length < 2) continue;
    groups.push({
      kind: "literal",
      hash: digest(value),
      minifiedBytes: value.length + 2,
      sites,
    });
  }
  return groups;
}

function groupFrom(hash: string, measured: readonly MeasuredSite[]): DuplicateGroup {
  const ordered = [...measured].sort((left, right) => {
    if (left.site.file < right.site.file) return -1;
    if (left.site.file > right.site.file) return 1;
    return left.site.line - right.site.line;
  });
  const seen = new Set<string>();
  const sites: DuplicateSite[] = [];
  let bytes = 0;
  for (const item of ordered) {
    const id = `${item.site.file}:${String(item.site.line)}:${String(item.site.endLine)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    sites.push(item.site);
    if (item.bytes > bytes) bytes = item.bytes;
  }
  return { kind: "function", hash, minifiedBytes: bytes, sites };
}

function measure(fn: Fn, from: number, to: number): MeasuredSite {
  const start = fn.tokens[from];
  const end = fn.tokens[to - 1];
  const sourceStart = start?.start ?? fn.start;
  const sourceEnd = end?.end ?? fn.end;
  return {
    bytes: estimateMinified(fn.source.slice(sourceStart, sourceEnd)),
    site: {
      file: fn.file,
      line: start?.line ?? fn.line,
      endLine: end?.line ?? fn.line,
      name: fn.name,
    },
  };
}

function pushFunction(
  raw: RawFn[],
  source: string,
  name: string,
  start: number,
  body: { start: number; end: number } | null,
): void {
  if (body === null) return;
  if (body.end <= body.start) return;
  raw.push({ name, line: lineAt(source, start), start: body.start, end: body.end });
}

function extend(
  left: Fn,
  leftAt: number,
  right: Fn,
  rightAt: number,
): {
  leftAt: number;
  leftEnd: number;
  rightAt: number;
  rightEnd: number;
} {
  let a0 = leftAt;
  let b0 = rightAt;
  let a1 = leftAt + DUPLICATE_WINDOW;
  let b1 = rightAt + DUPLICATE_WINDOW;
  while (a0 > 0 && b0 > 0 && left.tokens[a0 - 1]?.norm === right.tokens[b0 - 1]?.norm) {
    a0 -= 1;
    b0 -= 1;
  }
  while (
    a1 < left.tokens.length &&
    b1 < right.tokens.length &&
    left.tokens[a1]?.norm === right.tokens[b1]?.norm
  ) {
    a1 += 1;
    b1 += 1;
  }
  return { leftAt: a0, leftEnd: a1, rightAt: b0, rightEnd: b1 };
}

function overlaps(left: Fn, right: Fn): boolean {
  if (left.file !== right.file) return false;
  return left.start < right.end && right.start < left.end;
}

function pairKey(left: Fn, right: Fn): string {
  const a = `${left.file}:${String(left.start)}`;
  const b = `${right.file}:${String(right.start)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function tokenText(tokens: readonly Tok[], from: number, to: number): string {
  let text = "";
  for (let index = from; index < to; index += 1) {
    if (index > from) text += "\n";
    text += tokens[index]?.norm ?? "";
  }
  return text;
}

function dedupeSites(sites: readonly DuplicateSite[]): readonly DuplicateSite[] {
  const seen = new Set<string>();
  const unique: DuplicateSite[] = [];
  for (const site of sites) {
    const id = `${site.file}:${String(site.line)}:${String(site.endLine)}:${site.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(site);
  }
  unique.sort((left, right) => {
    if (left.file < right.file) return -1;
    if (left.file > right.file) return 1;
    return left.line - right.line;
  });
  return unique;
}

function byGroup(left: DuplicateGroup, right: DuplicateGroup): number {
  if (right.minifiedBytes !== left.minifiedBytes) return right.minifiedBytes - left.minifiedBytes;
  if (left.kind < right.kind) return -1;
  if (left.kind > right.kind) return 1;
  if (left.hash < right.hash) return -1;
  if (left.hash > right.hash) return 1;
  const leftSite = left.sites[0];
  const rightSite = right.sites[0];
  if (leftSite === undefined || rightSite === undefined) return 0;
  if (leftSite.file < rightSite.file) return -1;
  if (leftSite.file > rightSite.file) return 1;
  return leftSite.line - rightSite.line;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function lex(source: string, from: number, to: number, nested: readonly RawFn[]): readonly Tok[] {
  const holes = [...nested].sort((left, right) => left.start - right.start);
  const tokens: Tok[] = [];
  let index = from;
  let line = lineAt(source, from);
  let hole = 0;
  while (index < to) {
    while (hole < holes.length && holes[hole]!.end <= index) hole += 1;
    const skip = holes[hole];
    if (skip !== undefined && index >= skip.start && index < skip.end && skip.end <= to) {
      while (index < skip.end) {
        if (source.charCodeAt(index) === 10) line += 1;
        index += 1;
      }
      continue;
    }
    const code = source.charCodeAt(index);
    if (code === 10) {
      line += 1;
      index += 1;
      continue;
    }
    if (code === 13 || code === 32 || code === 9 || code === 12) {
      index += 1;
      continue;
    }
    if (code === 47 && source.charCodeAt(index + 1) === 47) {
      index += 2;
      while (index < to && source.charCodeAt(index) !== 10) index += 1;
      continue;
    }
    if (code === 47 && source.charCodeAt(index + 1) === 42) {
      index += 2;
      while (
        index < to &&
        !(source.charCodeAt(index) === 42 && source.charCodeAt(index + 1) === 47)
      ) {
        if (source.charCodeAt(index) === 10) line += 1;
        index += 1;
      }
      index = Math.min(to, index + 2);
      continue;
    }
    if (code === 34 || code === 39 || code === 96) {
      const end = Math.min(to, scanString(source, index));
      tokens.push({ norm: source.slice(index, end), line, start: index, end });
      for (let cursor = index; cursor < end; cursor += 1) {
        if (source.charCodeAt(cursor) === 10) line += 1;
      }
      index = end;
      continue;
    }
    if (isIdentStart(code)) {
      const start = index;
      index += 1;
      while (index < to && isIdentPart(source.charCodeAt(index))) index += 1;
      const text = source.slice(start, index);
      tokens.push({ norm: KEYWORDS.has(text) ? text : "#", line, start, end: index });
      continue;
    }
    if (isDigit(code) || (code === 46 && isDigit(source.charCodeAt(index + 1)))) {
      const start = index;
      index += 1;
      while (index < to && /[0-9a-zA-Z_.]/.test(source.charAt(index))) index += 1;
      tokens.push({ norm: source.slice(start, index), line, start, end: index });
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (op !== undefined) {
      tokens.push({ norm: op, line, start: index, end: index + op.length });
      index += op.length;
      continue;
    }
    tokens.push({ norm: source.charAt(index), line, start: index, end: index + 1 });
    index += 1;
  }
  return tokens;
}

function scanString(source: string, start: number): number {
  const quote = source.charCodeAt(start);
  if (quote === 96) return scanTemplate(source, start);
  let index = start + 1;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code === 92) {
      index += 2;
      continue;
    }
    if (code === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function scanTemplate(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code === 92) {
      index += 2;
      continue;
    }
    if (code === 96) return index + 1;
    if (code === 36 && source.charCodeAt(index + 1) === 123) {
      index += 2;
      let depth = 1;
      while (index < source.length && depth > 0) {
        const inner = source.charCodeAt(index);
        if (inner === 34 || inner === 39 || inner === 96) {
          index = scanString(source, index);
          continue;
        }
        if (inner === 123) depth += 1;
        else if (inner === 125) depth -= 1;
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return source.length;
}

function isIdentStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
}

function isIdentPart(code: number): boolean {
  return isIdentStart(code) || isDigit(code);
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, source.length);
  for (let index = 0; index < end; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function walkSrc(root: string): readonly string[] {
  const files: string[] = [];
  walk(root, join(root, "src"), files);
  files.sort();
  return files;
}

function walk(root: string, dir: string, files: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(root, join(dir, entry.name), files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx") && !entry.name.endsWith(".mts"))
      continue;
    const rel = posixRelative(root, join(dir, entry.name));
    if (!rel.startsWith("../")) files.push(rel);
  }
}

if (import.meta.main) {
  const root = repoRoot();
  process.stdout.write(formatDuplicates(duplicateGroups(root)));
}
