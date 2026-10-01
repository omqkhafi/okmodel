/**
 * Runtime identifier validation.
 *
 * Every emitted identifier is quoted. Names longer than 63 bytes, names with
 * NULs or controls, and empty names are rejected. Reserved words are quoted;
 * the unquoted form is rejected. This does not hash-suffix a long name: a
 * suffix would be a different column than the one the caller named.
 */

import { SafetyError, violation } from "./errors.js";

/** Postgres `NAMEDATALEN - 1`. */
export const POSTGRES_IDENTIFIER_MAX_BYTES = 63;

/**
 * Postgres reserved keywords.
 *
 * Unquoted SQL folds these into keywords. The emit path quotes them instead.
 * The list is the reserved class, not unreserved keywords.
 */
export const RESERVED_WORDS: readonly string[] = [
  "all",
  "analyse",
  "analyze",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "asymmetric",
  "both",
  "case",
  "cast",
  "check",
  "collate",
  "column",
  "constraint",
  "create",
  "current_catalog",
  "current_date",
  "current_role",
  "current_time",
  "current_timestamp",
  "current_user",
  "default",
  "deferrable",
  "desc",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "false",
  "fetch",
  "for",
  "foreign",
  "from",
  "grant",
  "group",
  "having",
  "in",
  "initially",
  "intersect",
  "into",
  "lateral",
  "leading",
  "limit",
  "localtime",
  "localtimestamp",
  "not",
  "null",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "placing",
  "primary",
  "references",
  "returning",
  "select",
  "session_user",
  "some",
  "symmetric",
  "table",
  "then",
  "to",
  "trailing",
  "true",
  "union",
  "unique",
  "user",
  "using",
  "variadic",
  "when",
  "where",
  "window",
  "with",
];

const RESERVED: ReadonlySet<string> = new Set(RESERVED_WORDS);

const UNQUOTED = /^[a-z_][a-z0-9_$]*$/u;

/**
 * UTF-8 size of a JavaScript string.
 *
 * @param value - Text
 * @returns Byte length
 */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Reports whether an unquoted identifier would be read as a keyword.
 *
 * Comparison is case-insensitive, matching Postgres folding.
 *
 * @param name - Candidate identifier
 * @returns True when the folded name is reserved
 */
export function isReservedWord(name: string): boolean {
  return RESERVED.has(name.toLowerCase());
}

/**
 * Checks the structural rules for one identifier.
 *
 * Reserved words pass: the emit path quotes them. Dots pass: they are part of
 * one quoted identifier, not a schema qualification.
 *
 * @param name - Candidate
 */
export function assertIdentifier(name: string): void {
  if (name.length === 0) {
    throw identifierError("Identifier is empty.");
  }
  const bytes = utf8ByteLength(name);
  if (bytes > POSTGRES_IDENTIFIER_MAX_BYTES) {
    throw identifierError(
      `Identifier is ${String(bytes)} bytes. The limit is ${String(POSTGRES_IDENTIFIER_MAX_BYTES)}.`,
    );
  }
  for (const char of name) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      throw identifierError("Identifier has an empty code point.");
    }
    if (char.length === 1 && code >= 0xd800 && code <= 0xdfff) {
      throw identifierError("Identifier has an unpaired surrogate.");
    }
    if (forbiddenCodePoint(code)) {
      throw identifierError(`Identifier contains a forbidden code point U+${code.toString(16)}.`);
    }
  }
}

/**
 * Quotes one identifier.
 *
 * Embedded quotes are doubled. The result is a single SQL identifier.
 *
 * @param name - Raw identifier
 * @returns Double-quoted text
 */
export function quoteIdentifier(name: string): string {
  assertIdentifier(name);
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Quotes `schema.table` as two identifiers.
 *
 * A dot inside {@link quoteIdentifier} stays inside one name. This splits.
 *
 * @param qualified - Dot-separated parts
 * @returns Quoted parts joined by dots
 */
export function quoteQualified(qualified: string): string {
  const parts = qualified.split(".");
  if (parts.length < 2) {
    return quoteIdentifier(qualified);
  }
  return parts.map((part) => quoteIdentifier(part)).join(".");
}

/**
 * Reverses {@link quoteIdentifier}.
 *
 * @param quoted - Text from {@link quoteIdentifier}
 * @returns The original name
 */
export function unquoteIdentifier(quoted: string): string {
  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) {
    throw identifierError("Quoted identifier is missing its quotes.");
  }
  const body = quoted.slice(1, -1);
  let name = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '"') {
      if (body[index + 1] !== '"') {
        throw identifierError("Quoted identifier ends early.");
      }
      name += '"';
      index += 1;
      continue;
    }
    name += char ?? "";
  }
  return name;
}

/**
 * Rejects a name that cannot be emitted without quotes.
 *
 * The production path uses {@link quoteIdentifier} and does not call this.
 * It exists so tests can show reserved words, mixed case, and non-ASCII fail
 * closed when quotes are forgotten.
 *
 * @param name - Candidate unquoted identifier
 */
export function assertUnquotedIdentifier(name: string): void {
  assertIdentifier(name);
  if (isReservedWord(name) || !UNQUOTED.test(name)) {
    throw identifierError(`Identifier ${name} cannot be emitted unquoted.`);
  }
}

/**
 * Checks a field name against a catalog list.
 *
 * Unknown names throw OKM1120. The name must also pass {@link assertIdentifier}.
 *
 * @param fields - Column names on the table
 * @param name - Requested field
 * @param role - Where the name appeared
 */
export function assertKnownField(
  fields: readonly string[],
  name: string,
  role: "where" | "select" | "orderBy" | "include",
): void {
  assertIdentifier(name);
  if (!fields.includes(name)) {
    throw new SafetyError([
      violation("OKM1120", "unknown-field", "", `Unknown ${role} field ${name}.`, "caller"),
    ]);
  }
}

/**
 * Reports whether a quoted identifier is exactly one SQL ident with no breakout.
 *
 * @param quoted - Output of {@link quoteIdentifier}
 * @returns True when a scanner stays inside one quoted ident
 */
export function isSingleQuotedIdentifier(quoted: string): boolean {
  if (!quoted.startsWith('"') || !quoted.endsWith('"') || quoted.length < 2) {
    return false;
  }
  let index = 1;
  const end = quoted.length - 1;
  while (index < end) {
    if (quoted[index] === '"') {
      if (quoted[index + 1] !== '"') {
        return false;
      }
      index += 2;
      continue;
    }
    index += 1;
  }
  return true;
}

function identifierError(detail: string): SafetyError {
  return new SafetyError([violation("OKM1120", "identifier", "", detail, "caller")]);
}

function forbiddenCodePoint(code: number): boolean {
  if (code <= 0x1f || code === 0x7f) {
    return true;
  }
  if (code >= 0x202a && code <= 0x202e) {
    return true;
  }
  if (code >= 0x2066 && code <= 0x2069) {
    return true;
  }
  if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) {
    return true;
  }
  if (code >= 0xfdd0 && code <= 0xfdef) {
    return true;
  }
  const low = code & 0xffff;
  return low === 0xfffe || low === 0xffff;
}
