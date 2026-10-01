/**
 * Fuzz identifier quoting. Accepted names round-trip; rejected names match an
 * independent structural check.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import { SafetyError } from "./errors.js";
import {
  POSTGRES_IDENTIFIER_MAX_BYTES,
  RESERVED_WORDS,
  isSingleQuotedIdentifier,
  quoteIdentifier,
  quoteQualified,
  unquoteIdentifier,
  utf8ByteLength,
} from "./identifier.js";

test("quoted identifiers round-trip and do not break out", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 80 }), (name) => {
      if (structurallyRejected(name)) {
        expect(() => quoteIdentifier(name)).toThrow(SafetyError);
        return;
      }
      const quoted = quoteIdentifier(name);
      expect(unquoteIdentifier(quoted)).toBe(name);
      expect(isSingleQuotedIdentifier(quoted)).toBe(true);
      expect(utf8ByteLength(name)).toBeLessThanOrEqual(POSTGRES_IDENTIFIER_MAX_BYTES);
    }),
    { numRuns: 200, seed: 1 },
  );
});

test("unicode strings follow the same quoting rules", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 40, unit: "binary" }), (name) => {
      if (structurallyRejected(name)) {
        expect(() => quoteIdentifier(name)).toThrow(SafetyError);
        return;
      }
      expect(unquoteIdentifier(quoteIdentifier(name))).toBe(name);
      expect(isSingleQuotedIdentifier(quoteIdentifier(name))).toBe(true);
    }),
    { numRuns: 100, seed: 1 },
  );
});

test("every reserved word is safe only when quoted", () => {
  for (const word of RESERVED_WORDS) {
    const quoted = quoteIdentifier(word);
    expect(quoted.startsWith('"')).toBe(true);
    expect(unquoteIdentifier(quoted)).toBe(word);
    expect(isSingleQuotedIdentifier(quoted)).toBe(true);
  }
});

test("dot-separated names quote each part or reject an empty part", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.string({ minLength: 1, maxLength: 12 }).filter((part) => !part.includes(".")),
        { minLength: 2, maxLength: 3 },
      ),
      (parts) => {
        const qualified = parts.join(".");
        if (parts.some((part) => structurallyRejected(part))) {
          expect(() => quoteQualified(qualified)).toThrow(SafetyError);
          return;
        }
        const quoted = quoteQualified(qualified);
        expect(quoted.split(".").length).toBe(parts.length);
        expect(quoted.includes(`".`)).toBe(true);
      },
    ),
    { numRuns: 50, seed: 1 },
  );
});

function structurallyRejected(name: string): boolean {
  if (name.length === 0 || utf8ByteLength(name) > POSTGRES_IDENTIFIER_MAX_BYTES) {
    return true;
  }
  for (const char of name) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      return true;
    }
    if (char.length === 1 && code >= 0xd800 && code <= 0xdfff) {
      return true;
    }
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
    if ((code & 0xffff) === 0xfffe || (code & 0xffff) === 0xffff) {
      return true;
    }
  }
  return false;
}
