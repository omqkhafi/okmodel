/**
 * Identifier rules and deterministic constraint and index names.
 *
 * Postgres stores 63 bytes (`NAMEDATALEN` minus the trailing NUL). A generated
 * name that would be longer keeps a hash suffix so two long names stay distinct.
 * The name is a function of a stable key, not of the field's current name, so
 * renaming a field does not rename the constraint.
 */

import { catalogError } from "../error.js";
import { sha256 } from "../sha256.js";
import { truncateUtf8, utf8ByteLength } from "../utf8.js";
import { reservedWords } from "./words.js";

/** Maximum Postgres identifier size in bytes. `NAMEDATALEN - 1`. */
export const POSTGRES_IDENTIFIER_MAX_BYTES = 63;

const SUFFIX_HEX = 8;
const SUFFIX_BYTES = SUFFIX_HEX + 1;

/** Why a constraint or index name is being generated. */
export type NamePurpose = "primaryKey" | "unique" | "foreignKey" | "check" | "index";

const NAME_TAG: { readonly [K in Exclude<NamePurpose, "primaryKey">]: string } = {
  unique: "key",
  foreignKey: "fkey",
  check: "check",
  index: "idx",
};

export { utf8ByteLength };

/**
 * Reports whether a name is an unquoted reserved word.
 *
 * Comparison is case-insensitive.
 *
 * @param name - Candidate identifier
 * @returns `true` when Postgres would reject the unquoted word
 */
export function isReservedIdentifier(name: string): boolean {
  return reservedWords().has(name.toLowerCase());
}

/**
 * Rejects a name that fails the identifier rules.
 *
 * The rules are empty, NUL, other control characters, byte length, and an
 * unquoted reserved word (OKM1122).
 *
 * @param name - Candidate identifier
 * @param role - What the name refers to, used in the error
 * @param limit - Dialect byte limit. Defaults to the Postgres limit
 */
export function assertIdentifier(
  name: string,
  role: string,
  limit = POSTGRES_IDENTIFIER_MAX_BYTES,
): void {
  assertLimit(limit);
  assertIdentifierText(name, role);
  if (utf8ByteLength(name) > limit) {
    catalogError(
      "OKM1122",
      `${role} ${name} is ${String(utf8ByteLength(name))} bytes. The limit is ${String(limit)}.`,
    );
  }
  if (isReservedIdentifier(name)) {
    catalogError("OKM1122", `${role} ${name} is a reserved word.`);
  }
}

/**
 * Returns a name the dialect can store without truncating it.
 *
 * Names that already fit are unchanged, including reserved words (those are
 * rejected by {@link assertIdentifier} before a name is stored). Longer names
 * become a UTF-8 prefix, an underscore, and the first 8 hex characters of the
 * SHA-256 of the original name.
 *
 * @param name - Requested identifier
 * @param limit - Dialect byte limit. Defaults to the Postgres limit
 * @returns The name to store
 */
export function fitIdentifier(name: string, limit = POSTGRES_IDENTIFIER_MAX_BYTES): string {
  assertLimit(limit);
  assertIdentifierText(name, "identifier");
  if (utf8ByteLength(name) <= limit) {
    return name;
  }
  const suffix = `_${sha256(name).slice(0, SUFFIX_HEX)}`;
  const budget = limit - SUFFIX_BYTES;
  return `${truncateUtf8(name, budget)}${suffix}`;
}

/**
 * Generates a constraint or index name.
 *
 * Primary keys are `{parent}_pkey`, so the column name is not part of the
 * name. Other purposes are `{parent}_{nameKey}_{tag}`. `nameKey` is chosen
 * once and kept; a later field rename must pass the same key. A result that
 * exceeds `limit` is fitted with a hash suffix.
 *
 * @param input - Parent, purpose, stable key, and dialect limit
 * @returns The name to store on the object
 */
export function deterministicName(input: {
  readonly parent: string;
  readonly purpose: NamePurpose;
  readonly nameKey?: string;
  readonly limit?: number;
}): string {
  const limit = input.limit ?? POSTGRES_IDENTIFIER_MAX_BYTES;
  assertIdentifier(input.parent, "parent", limit);
  if (input.purpose === "primaryKey") {
    return fitIdentifier(`${input.parent}_pkey`, limit);
  }
  const nameKey = input.nameKey ?? "";
  assertIdentifierText(nameKey, "name key");
  return fitIdentifier(`${input.parent}_${nameKey}_${NAME_TAG[input.purpose]}`, limit);
}

/**
 * Rejects NUL and other control characters in text that is not an identifier.
 *
 * @param value - Text stored in a definition
 * @param role - What the text refers to
 */
export function assertStoredText(value: string, role: string): void {
  if (value.includes("\u0000") || hasControl(value)) {
    catalogError("OKM1122", `${role} contains a control character.`);
  }
}

function assertIdentifierText(name: string, role: string): void {
  if (name.length === 0) {
    catalogError("OKM1122", `${role} is empty.`);
  }
  if (name.includes("\u0000")) {
    catalogError("OKM1122", `${role} ${name} contains NUL.`);
  }
  if (hasControl(name)) {
    catalogError("OKM1122", `${role} ${name} contains a control character.`);
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < SUFFIX_BYTES) {
    catalogError(
      "OKM1122",
      `Identifier limit is ${String(limit)} bytes. It must be at least ${String(SUFFIX_BYTES)} so a fitted name can keep its hash suffix.`,
    );
  }
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}
