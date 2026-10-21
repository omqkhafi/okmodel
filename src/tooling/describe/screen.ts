/**
 * Lexical screen for result nullability.
 *
 * A NOT NULL catalog column stays nullable when the statement contains one of
 * these words outside comments, strings, and quoted identifiers. The lexer is
 * the migration scanner. This file does not parse SQL.
 */

import { sqlIdentifiers } from "../migrate/sql-lex.js";

const BLOCKS: ReadonlySet<string> = new Set([
  "join",
  "union",
  "intersect",
  "except",
  "lateral",
  "with",
  "values",
  "rollup",
  "cube",
  "grouping",
]);

/**
 * Whether `sql` can hide a NOT NULL column.
 *
 * The match is a case-insensitive whole word. A word inside a comment, a
 * string, or a quoted identifier does not count.
 *
 * @param sql - One statement
 * @returns True when the catalog alone cannot prove NOT NULL
 */
export function statementBlocksNotNull(sql: string): boolean {
  for (const name of sqlIdentifiers(sql)) {
    if (!name.quoted && BLOCKS.has(name.text.toLowerCase())) return true;
  }
  return false;
}
