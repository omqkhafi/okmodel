/**
 * Splits one migration step into statements.
 *
 * Comments are removed. A semicolon splits only at the top level.
 * `standard_conforming_strings` is on: a plain `'...'` ends on a single
 * quote, and `''` is one quote inside it. `E'...'` still treats a backslash
 * as an escape. A dollar quote runs until the same tag; a different tag
 * inside it is text, so `$outer$ ... $inner$ ... $inner$ ... $outer$` stays
 * one span. An unterminated string, quoted identifier, block comment, or
 * dollar quote is one opaque tail. This function does not throw.
 */

/** Statements of `sql`, comments removed, with no trailing semicolon. */
export function sqlStatements(sql: string): readonly string[] {
  return scan(sql).statements;
}

/**
 * Whether `sql` still has an open quote or block comment.
 *
 * A line comment does not count: it ends at the newline or at the end.
 *
 * @param sql - Step text accumulated so far
 * @returns `true` when a later blank line is still inside that quote
 */
export function sqlQuoteOpen(sql: string): boolean {
  return scan(sql).open;
}

type Scan = {
  readonly statements: readonly string[];
  readonly open: boolean;
};

function scan(sql: string): Scan {
  const statements: string[] = [];
  const parts: string[] = [];
  let index = 0;
  let open = false;

  const flush = (): void => {
    const text = parts.join("").trim();
    parts.length = 0;
    if (text.length > 0) statements.push(text);
  };

  while (index < sql.length) {
    if (sql.startsWith("--", index)) {
      parts.push(" ");
      index = lineCommentEnd(sql, index + 2);
      continue;
    }
    if (sql.startsWith("/*", index)) {
      parts.push(" ");
      const block = blockComment(sql, index + 2);
      index = block.index;
      if (block.open) {
        open = true;
        break;
      }
      continue;
    }
    const dollar = dollarAt(sql, index);
    if (dollar !== undefined) {
      const closed = takeDollar(sql, dollar);
      parts.push(sql.slice(index, closed.index));
      index = closed.index;
      if (closed.open) {
        open = true;
        break;
      }
      continue;
    }
    if (isEscapeString(sql, index)) {
      const quote = takeQuoted(sql, index + 2, true);
      parts.push(sql.slice(index, quote.index));
      index = quote.index;
      if (quote.open) {
        open = true;
        break;
      }
      continue;
    }
    const char = sql[index];
    if (char === "'") {
      const quote = takeQuoted(sql, index + 1, false);
      parts.push(sql.slice(index, quote.index));
      index = quote.index;
      if (quote.open) {
        open = true;
        break;
      }
      continue;
    }
    if (char === '"') {
      const quote = takeIdent(sql, index + 1);
      parts.push(sql.slice(index, quote.index));
      index = quote.index;
      if (quote.open) {
        open = true;
        break;
      }
      continue;
    }
    if (char === ";") {
      flush();
      index += 1;
      continue;
    }
    parts.push(char ?? "");
    index += 1;
  }

  flush();
  return { statements, open };
}

function lineCommentEnd(sql: string, index: number): number {
  while (index < sql.length && sql.charCodeAt(index) !== 10) index += 1;
  return index;
}

function blockComment(
  sql: string,
  index: number,
): { readonly index: number; readonly open: boolean } {
  let depth = 1;
  while (index < sql.length) {
    if (sql.startsWith("/*", index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (sql.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
      if (depth === 0) return { index, open: false };
      continue;
    }
    index += 1;
  }
  return { index, open: true };
}

type Dollar = { readonly tag: string; readonly end: number };

function dollarAt(sql: string, index: number): Dollar | undefined {
  if (sql.charCodeAt(index) !== 36) return undefined;
  const next = index + 1;
  if (sql.charCodeAt(next) === 36) return { tag: "", end: next + 1 };
  if (!isIdentStart(sql.charCodeAt(next))) return undefined;
  let cursor = next + 1;
  while (isIdentCont(sql.charCodeAt(cursor))) cursor += 1;
  if (sql.charCodeAt(cursor) !== 36) return undefined;
  return { tag: sql.slice(next, cursor), end: cursor + 1 };
}

function takeDollar(
  sql: string,
  dollar: Dollar,
): { readonly index: number; readonly open: boolean } {
  const closer = `$${dollar.tag}$`;
  const found = sql.indexOf(closer, dollar.end);
  if (found === -1) return { index: sql.length, open: true };
  return { index: found + closer.length, open: false };
}

function takeQuoted(
  sql: string,
  index: number,
  escape: boolean,
): { readonly index: number; readonly open: boolean } {
  while (index < sql.length) {
    const char = sql[index];
    if (escape && char === "\\") {
      if (index + 1 >= sql.length) return { index: sql.length, open: true };
      index += 2;
      continue;
    }
    if (char === "'") {
      if (sql[index + 1] === "'") {
        index += 2;
        continue;
      }
      return { index: index + 1, open: false };
    }
    index += 1;
  }
  return { index, open: true };
}

function takeIdent(sql: string, index: number): { readonly index: number; readonly open: boolean } {
  while (index < sql.length) {
    if (sql[index] === '"') {
      if (sql[index + 1] === '"') {
        index += 2;
        continue;
      }
      return { index: index + 1, open: false };
    }
    index += 1;
  }
  return { index, open: true };
}

function isEscapeString(sql: string, index: number): boolean {
  const code = sql.charCodeAt(index);
  if (code !== 69 && code !== 101) return false;
  if (sql.charCodeAt(index + 1) !== 39) return false;
  if (index > 0 && isIdentCont(sql.charCodeAt(index - 1))) return false;
  return true;
}

function isIdentStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isIdentCont(code: number): boolean {
  return isIdentStart(code) || (code >= 48 && code <= 57);
}
