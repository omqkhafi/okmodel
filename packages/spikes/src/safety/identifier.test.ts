/**
 * Runtime identifier rules: quoting, the 63-byte limit, reserved words, unicode.
 */

import { expect, test } from "bun:test";

import { POSTGRES_IDENTIFIER_MAX_BYTES as CATALOG_MAX } from "../catalog/identifier.js";
import { SafetyError } from "./errors.js";
import {
  POSTGRES_IDENTIFIER_MAX_BYTES,
  assertKnownField,
  assertUnquotedIdentifier,
  isSingleQuotedIdentifier,
  quoteIdentifier,
  quoteQualified,
  unquoteIdentifier,
  utf8ByteLength,
} from "./identifier.js";

test("the byte limit matches the catalog spike", () => {
  expect(POSTGRES_IDENTIFIER_MAX_BYTES).toBe(CATALOG_MAX);
  expect(POSTGRES_IDENTIFIER_MAX_BYTES).toBe(63);
});

test("a name at the limit is quoted and a longer name is rejected", () => {
  const fit = "a".repeat(POSTGRES_IDENTIFIER_MAX_BYTES);
  expect(unquoteIdentifier(quoteIdentifier(fit))).toBe(fit);
  expect(() => quoteIdentifier(`${fit}b`)).toThrow(SafetyError);
});

test("multibyte characters count bytes, not code units", () => {
  const fit = "é".repeat(31);
  expect(utf8ByteLength(fit)).toBe(62);
  expect(unquoteIdentifier(quoteIdentifier(fit))).toBe(fit);
  expect(utf8ByteLength("é".repeat(32))).toBe(64);
  expect(() => quoteIdentifier("é".repeat(32))).toThrow(/63/);
});

test("quotes, comments, and statement breaks stay inside one identifier", () => {
  for (const name of [
    'a"; drop table users; --',
    "users'; drop table users; --",
    "select",
    "user",
    "with",
    "a\nb",
    "タ",
    "public.users",
  ]) {
    if (name.includes("\n")) {
      expect(() => quoteIdentifier(name)).toThrow(SafetyError);
      continue;
    }
    const quoted = quoteIdentifier(name);
    expect(isSingleQuotedIdentifier(quoted)).toBe(true);
    expect(unquoteIdentifier(quoted)).toBe(name);
  }
});

test("reserved words and unicode cannot be emitted unquoted", () => {
  expect(quoteIdentifier("select")).toBe('"select"');
  expect(quoteIdentifier("Select")).toBe('"Select"');
  expect(() => assertUnquotedIdentifier("select")).toThrow(/unquoted/);
  expect(() => assertUnquotedIdentifier("Select")).toThrow(/unquoted/);
  expect(() => assertUnquotedIdentifier("タスク")).toThrow(/unquoted/);
  expect(unquoteIdentifier(quoteIdentifier("タスク"))).toBe("タスク");
  assertUnquotedIdentifier("tasks");
});

test("NUL, controls, bidi overrides, and zero-width characters are rejected", () => {
  for (const name of ["a\0b", "a\u0007b", "a\u202eb", "a\u200bb", "a\ufeffb", "a\ufffeb"]) {
    expect(() => quoteIdentifier(name)).toThrow(SafetyError);
  }
});

test("qualification quotes each part and rejects an empty part", () => {
  expect(quoteQualified("public.tasks")).toBe('"public"."tasks"');
  expect(() => quoteQualified("public.")).toThrow(/empty/i);
  expect(quoteIdentifier("public.tasks")).toBe('"public.tasks"');
});

test("unknown fields are OKM1120 and a lookalike is not the catalog name", () => {
  expect(() => assertKnownField(["tenantId"], "tenant\u0456d", "where")).toThrow(/OKM1120/);
  expect(() => assertKnownField(["title"], "title", "orderBy")).not.toThrow();
  expect(() => assertKnownField(["title"], "nope", "select")).toThrow(/OKM1120/);
});
