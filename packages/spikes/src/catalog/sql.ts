/**
 * SQL quoting and expression text cleanup.
 *
 * Quoting is for identifiers and string literals the spike emits. Check and
 * policy expressions are authoring SQL from the catalog, not parameters.
 */

import { CatalogError } from "./object.js";

/**
 * Quotes an identifier.
 *
 * @param name - Raw identifier
 * @returns A double-quoted identifier
 */
export function quoteIdent(name: string): string {
  if (name.length === 0) throw new CatalogError("Empty identifier.");
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Quotes a SQL string literal.
 *
 * @param value - Raw text
 * @returns A single-quoted literal
 */
export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Collapses whitespace, drops a leading `CHECK`, and strips wrapping parentheses.
 *
 * @param expression - SQL fragment from the catalog or from `pg_get_constraintdef`
 * @returns A comparable expression
 */
export function normalizeExpression(expression: string): string {
  let text = expression.trim().toLowerCase().replace(/\s+/g, " ");
  if (text.startsWith("check ")) text = text.slice("check ".length).trim();
  return stripParens(text);
}

function stripParens(text: string): string {
  let current = text.trim();
  while (
    current.length >= 2 &&
    current.startsWith("(") &&
    current.endsWith(")") &&
    wraps(current)
  ) {
    current = current.slice(1, -1).trim();
  }
  return current;
}

function wraps(text: string): boolean {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0 && index !== text.length - 1) return false;
    }
  }
  return depth === 0;
}
