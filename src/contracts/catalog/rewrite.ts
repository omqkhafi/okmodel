/**
 * Rewrites an identifier inside stored expression text.
 *
 * Check expressions and index predicates are text (D128). A declared rename
 * updates references in that text and leaves string literals alone.
 */

/**
 * Replaces `from` with `to` outside single-quoted strings.
 *
 * Quoted identifiers (`"from"`) and bare words both change. A word inside a
 * SQL string does not.
 *
 * @param text - Expression text
 * @param from - Identifier to replace
 * @param to - Replacement identifier
 * @returns The expression, or the same string when nothing changed
 */
export function replaceIdentifier(text: string, from: string, to: string): string {
  if (from.length === 0 || from === to || !text.includes(from)) {
    return text;
  }
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "'") {
      const end = endOfLiteral(text, index, "'");
      out += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === '"') {
      const end = endOfLiteral(text, index, '"');
      const body = text.slice(index + 1, end - 1).replaceAll('""', '"');
      out += body === from ? `"${to.replaceAll('"', '""')}"` : text.slice(index, end);
      index = end;
      continue;
    }
    if (isIdentStart(char)) {
      let end = index + 1;
      while (end < text.length && isIdentPart(text[end] ?? "")) end += 1;
      const word = text.slice(index, end);
      out += word === from ? to : word;
      index = end;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function endOfLiteral(text: string, start: number, quote: "'" | '"'): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === quote && text[index + 1] === quote) {
      index += 2;
      continue;
    }
    if (text[index] === quote) return index + 1;
    index += 1;
  }
  return text.length;
}

function isIdentStart(char: string): boolean {
  return (char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_";
}

function isIdentPart(char: string): boolean {
  return isIdentStart(char) || (char >= "0" && char <= "9");
}
