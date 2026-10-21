/**
 * Identity of one typed `raw()` statement.
 *
 * Line endings become LF and the ends are trimmed. The key is the SHA-256 of
 * `postgres` plus that text. The runtime uses the same function.
 */

import { sha256 } from "../../contracts/sha256.js";

/**
 * Line endings to LF, then trim.
 *
 * Nothing else changes. A string that is already normalised stays the same.
 *
 * @param sql - Statement text from a literal
 * @returns The text the lock stores and the hash covers
 */
export function normaliseRawSql(sql: string): string {
  return sql.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

/**
 * Lock key for one statement.
 *
 * @param sql - Statement text. Normalised here
 * @returns Lowercase SHA-256 hex
 */
export function rawStatementKey(sql: string): string {
  return sha256(`postgres\n${normaliseRawSql(sql)}`);
}
