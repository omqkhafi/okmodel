/**
 * Postgres identifier limit.
 *
 * `NAMEDATALEN` is 64, including the trailing NUL, so an identifier may be 63
 * bytes. Postgres truncates the rest and will collapse two long names onto one.
 * Fitted names keep a hash suffix so those two names stay distinct.
 */

import { CatalogError, utf8Bytes } from "./object.js";
import { sha256 } from "./canonical.js";

/** Maximum identifier size in bytes. `NAMEDATALEN - 1`. */
export const POSTGRES_IDENTIFIER_MAX_BYTES = 63;

const SUFFIX_HEX = 8;

/**
 * Returns a name Postgres can store without truncating it.
 *
 * Names that already fit are unchanged. Longer names become a UTF-8 prefix,
 * an underscore, and the first 8 hex characters of the SHA-256 of the original
 * name. The result is at most 63 bytes.
 *
 * @param name - Requested identifier
 * @returns The name to store in the catalog and emit in SQL
 */
export function fitIdentifier(name: string): string {
  if (utf8Bytes(name) <= POSTGRES_IDENTIFIER_MAX_BYTES) return name;
  const suffix = `_${sha256(name).slice(0, SUFFIX_HEX)}`;
  const budget = POSTGRES_IDENTIFIER_MAX_BYTES - utf8Bytes(suffix);
  return `${truncateUtf8(name, budget)}${suffix}`;
}

/**
 * Throws when a name would be truncated by Postgres.
 *
 * @param name - Identifier about to be emitted or stored
 * @param role - What the name refers to, used in the error
 */
export function assertIdentifierFits(name: string, role: string): void {
  if (utf8Bytes(name) <= POSTGRES_IDENTIFIER_MAX_BYTES) return;
  throw new CatalogError(
    `${role} ${name} is ${String(utf8Bytes(name))} bytes. The limit is ${String(POSTGRES_IDENTIFIER_MAX_BYTES)}. Fit it with a hash suffix before storing it.`,
  );
}

function truncateUtf8(name: string, budget: number): string {
  const bytes = new TextEncoder().encode(name);
  let length = Math.min(budget, bytes.length);
  while (length > 0) {
    const next = bytes[length];
    if (next === undefined || (next & 0xc0) !== 0x80) break;
    length -= 1;
  }
  return new TextDecoder().decode(bytes.subarray(0, length));
}
