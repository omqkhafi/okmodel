/**
 * Scans a routine body for transaction control.
 *
 * Strings, comments, and dollar quotes are skipped. The scan is the
 * declaration check (OKM1551) and the exception-block warning (OKM2126).
 */

/** What a body does with `COMMIT` and `ROLLBACK`. */
export type RoutineControl = {
  /** The body contains `COMMIT` or `ROLLBACK` outside a string. */
  readonly commits: boolean;
  /** That statement sits inside an `EXCEPTION` handler. */
  readonly commitInException: boolean;
};

/**
 * Reports transaction control in a routine body.
 *
 * @param sql - Body text, or a whole `BEGIN ATOMIC` block
 * @returns Whether the body commits, and whether that commit is in a handler
 */
export function routineControl(sql: string): RoutineControl {
  const tokens = scan(sql);
  return {
    commits: tokens.some((token) => token.word === "commit" || token.word === "rollback"),
    commitInException: tokens.some(
      (token) => token.inException && (token.word === "commit" || token.word === "rollback"),
    ),
  };
}

type Token = { readonly word: string; readonly inException: boolean };

function scan(sql: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let exception = 0;
  let block = 0;
  while (index < sql.length) {
    const char = sql[index] ?? "";
    if (char === "-" && sql[index + 1] === "-") {
      index = lineEnd(sql, index + 2);
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      index = close < 0 ? sql.length : close + 2;
      continue;
    }
    if (char === "'") {
      index = quoteEnd(sql, index + 1);
      continue;
    }
    if (char === "$") {
      const tag = dollarTag(sql, index);
      if (tag !== undefined) {
        const close = sql.indexOf(tag, index + tag.length);
        index = close < 0 ? sql.length : close + tag.length;
        continue;
      }
    }
    if (!isWord(char)) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < sql.length && isWord(sql[index] ?? "")) index += 1;
    const word = sql.slice(start, index).toLowerCase();
    if (word === "begin") block += 1;
    if (word === "exception" && block > 0) exception += 1;
    if (word === "end" && block > 0) {
      block -= 1;
      if (exception > block) exception = block;
    }
    tokens.push({ word, inException: exception > 0 });
  }
  return tokens;
}

function isWord(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_";
}

function lineEnd(sql: string, index: number): number {
  const next = sql.indexOf("\n", index);
  return next < 0 ? sql.length : next + 1;
}

function quoteEnd(sql: string, index: number): number {
  while (index < sql.length) {
    if (sql[index] === "'") {
      if (sql[index + 1] === "'") {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return index;
}

function dollarTag(sql: string, index: number): string | undefined {
  let end = index + 1;
  while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end] ?? "")) end += 1;
  if (sql[end] !== "$") return undefined;
  return sql.slice(index, end + 1);
}
