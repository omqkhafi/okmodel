/**
 * Splits one migration step into statements.
 *
 * Comments are removed. A semicolon splits only at the top level.
 * `standard_conforming_strings` is on: a plain `'...'` ends on a single
 * quote, and `''` is one quote inside it. `E'...'` still treats a backslash
 * as an escape. A dollar quote runs until the same tag; a different tag
 * inside it is text, so `$outer$ ... $inner$ ... $inner$ ... $outer$` stays
 * one span. A `BEGIN ATOMIC` body of `CREATE FUNCTION` or `CREATE PROCEDURE`
 * stays in that statement: a semicolon inside it does not split, and
 * `CASE ... END` does not close the body. `BEGIN ATOMIC` elsewhere still
 * splits. An unterminated string, quoted identifier, block comment, dollar
 * quote, or atomic body is one opaque tail. This function does not throw.
 */

/** Statements of `sql`, comments removed, with no trailing semicolon. */
export function sqlStatements(sql: string): readonly string[] {
  return scan(sql).statements;
}

/**
 * Whether `sql` still has an open quote or block comment.
 *
 * A line comment does not count: it ends at the newline or at the end.
 * An unclosed `BEGIN ATOMIC` routine body counts too.
 *
 * @param sql - Step text accumulated so far
 * @returns `true` when a later blank line is still inside that quote or body
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
  let atomic = 0;

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
      if (atomic === 0) flush();
      else parts.push(";");
      index += 1;
      continue;
    }
    if (isIdentStart(sql.charCodeAt(index))) {
      const word = readWord(sql, index);
      const lower = word.toLowerCase();
      if (atomic > 0 && lower === "case") atomic += 1;
      else if (atomic > 0 && lower === "end") atomic -= 1;
      else if (lower === "begin" && nextWordIs(sql, index + word.length, "atomic")) {
        if (atomic > 0 || isRoutineHead(parts.join(""))) atomic += 1;
      }
      parts.push(word);
      index += word.length;
      continue;
    }
    parts.push(char ?? "");
    index += 1;
  }

  flush();
  return { statements, open: open || atomic > 0 };
}

/**
 * Transaction control in a migration step.
 *
 * Dollar-quoted bodies are scanned only for a `DO` block. `CREATE FUNCTION`
 * and `CREATE PROCEDURE` may commit inside their own body. A `BEGIN ATOMIC`
 * body stays one statement, so its `END` is not transaction control. A bare
 * `BEGIN` or `END` inside a `DO` body is plpgsql and is ignored. `ROLLBACK TO`
 * does not end the outer transaction.
 *
 * @param sql - Step text
 * @returns The command, or `undefined` when the step stays in one transaction
 */
export function transactionControl(sql: string): string | undefined {
  for (const statement of sqlStatements(sql)) {
    const top = controlWord(statement, false);
    if (top !== undefined) return top;
    if (!isDo(statement)) continue;
    for (const body of dollarBodies(statement)) {
      for (const inner of sqlStatements(body)) {
        const hit = controlWord(inner, true);
        if (hit !== undefined) return hit;
      }
    }
  }
  return undefined;
}

function isDo(statement: string): boolean {
  return /^do(?:\s|$)/i.test(statement.trim());
}

function controlWord(statement: string, insideBody: boolean): string | undefined {
  let text = statement.trim().replace(/\s+/g, " ").toLowerCase();
  if (insideBody && /^begin(?:\s|$)/.test(text) && !/^begin\s+(?:work|transaction)\b/.test(text)) {
    text = text.replace(/^begin\s+/, "").trim();
    if (text.length === 0) return undefined;
  }
  if (/^commit(?:\s+(?:work|transaction|prepared\b.*))?$/.test(text)) return "commit";
  if (text === "abort") return "abort";
  if (/^rollback(?:\s+(?:work|transaction|prepared\b.*))?$/.test(text)) return "rollback";
  if (/^prepare\s+transaction\b/.test(text)) return "prepare transaction";
  if (/^start\s+transaction\b/.test(text)) return "start transaction";
  if (/^begin(?:\s+(?:work|transaction)\b.*)?$/.test(text) || /^begin\s+\S/.test(text)) {
    if (insideBody && !/^begin\s+(?:work|transaction)\b/.test(text)) return undefined;
    return "begin";
  }
  if (/^end(?:\s+(?:work|transaction))?$/.test(text)) {
    if (insideBody && text === "end") return undefined;
    return "end";
  }
  return undefined;
}

function dollarBodies(sql: string): readonly string[] {
  const bodies: string[] = [];
  let index = 0;
  while (index < sql.length) {
    if (sql.startsWith("--", index)) {
      index = lineCommentEnd(sql, index + 2);
      continue;
    }
    if (sql.startsWith("/*", index)) {
      index = blockComment(sql, index + 2).index;
      continue;
    }
    if (isEscapeString(sql, index)) {
      index = takeQuoted(sql, index + 2, true).index;
      continue;
    }
    if (sql[index] === "'") {
      index = takeQuoted(sql, index + 1, false).index;
      continue;
    }
    if (sql[index] === '"') {
      index = takeIdent(sql, index + 1).index;
      continue;
    }
    const dollar = dollarAt(sql, index);
    if (dollar !== undefined) {
      const closed = takeDollar(sql, dollar);
      if (!closed.open) {
        const closer = `$${dollar.tag}$`.length;
        bodies.push(sql.slice(dollar.end, closed.index - closer));
      }
      index = closed.index;
      continue;
    }
    index += 1;
  }
  return bodies;
}

function readWord(sql: string, index: number): string {
  let cursor = index + 1;
  while (isIdentCont(sql.charCodeAt(cursor))) cursor += 1;
  return sql.slice(index, cursor);
}

function nextWordIs(sql: string, index: number, expected: string): boolean {
  const at = skipTrivia(sql, index);
  if (!isIdentStart(sql.charCodeAt(at))) return false;
  return readWord(sql, at).toLowerCase() === expected;
}

function skipTrivia(sql: string, index: number): number {
  while (index < sql.length) {
    const code = sql.charCodeAt(index);
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      index += 1;
      continue;
    }
    if (sql.startsWith("--", index)) {
      index = lineCommentEnd(sql, index + 2);
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const block = blockComment(sql, index + 2);
      if (block.open) return sql.length;
      index = block.index;
      continue;
    }
    return index;
  }
  return index;
}

function isRoutineHead(text: string): boolean {
  return /^create(?:\s+or\s+replace)?\s+(?:function|procedure)\b/i.test(
    text.replace(/\s+/g, " ").trim(),
  );
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

/** One identifier {@link sqlIdentifiers} found outside a string or a comment. */
export type SqlName = {
  /** Spelling as written. A quoted name is unescaped. An unquoted name is not folded. */
  readonly text: string;
  /** True when the name was a double-quoted identifier. */
  readonly quoted: boolean;
};

/**
 * Identifiers outside comments, strings, and dollar quotes.
 *
 * The quote rules are the same ones {@link sqlStatements} uses. A name inside
 * a string or a dollar quote is not a match: Postgres still resolves
 * `'notes'::regclass`, and this scan does not.
 *
 * @param sql - Function body or view query
 * @returns Identifiers in source order
 */
export function sqlIdentifiers(sql: string): readonly SqlName[] {
  const names: SqlName[] = [];
  let index = 0;
  while (index < sql.length) {
    if (sql.startsWith("--", index)) {
      index = lineCommentEnd(sql, index + 2);
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const block = blockComment(sql, index + 2);
      index = block.index;
      if (block.open) break;
      continue;
    }
    const dollar = dollarAt(sql, index);
    if (dollar !== undefined) {
      const closed = takeDollar(sql, dollar);
      index = closed.index;
      if (closed.open) break;
      continue;
    }
    if (isEscapeString(sql, index)) {
      const quote = takeQuoted(sql, index + 2, true);
      index = quote.index;
      if (quote.open) break;
      continue;
    }
    const char = sql[index];
    if (char === "'") {
      const quote = takeQuoted(sql, index + 1, false);
      index = quote.index;
      if (quote.open) break;
      continue;
    }
    if (char === '"') {
      const quote = takeIdent(sql, index + 1);
      if (!quote.open) {
        names.push({ text: unescapeIdent(sql.slice(index + 1, quote.index - 1)), quoted: true });
      }
      index = quote.index;
      if (quote.open) break;
      continue;
    }
    if (isIdentStart(sql.charCodeAt(index))) {
      const word = readWord(sql, index);
      names.push({ text: word, quoted: false });
      index += word.length;
      continue;
    }
    index += 1;
  }
  return names;
}

function unescapeIdent(text: string): string {
  return text.replaceAll('""', '"');
}

function isIdentStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isIdentCont(code: number): boolean {
  return isIdentStart(code) || (code >= 48 && code <= 57);
}
