import { expect, test } from "bun:test";

import { withPgliteSchema, withPostgresSchema } from "@okmodel/harness";

import { fitIdentifier, POSTGRES_IDENTIFIER_MAX_BYTES } from "./identifier.js";
import { utf8Bytes, resolveNamespace, templateNamespace } from "./object.js";
import { quoteIdent } from "./sql.js";
import { loadPostgresGate, postgresTest, requirePostgresWhenAsked } from "./gate.js";

test("names at the 63-byte limit are unchanged", () => {
  const name = "a".repeat(POSTGRES_IDENTIFIER_MAX_BYTES);
  expect(fitIdentifier(name)).toBe(name);
  expect(utf8Bytes(fitIdentifier(`${name}b`))).toBeLessThanOrEqual(POSTGRES_IDENTIFIER_MAX_BYTES);
});

test("a hash suffix keeps two truncated names distinct", () => {
  const left = `${"a".repeat(POSTGRES_IDENTIFIER_MAX_BYTES)}1`;
  const right = `${"a".repeat(POSTGRES_IDENTIFIER_MAX_BYTES)}2`;
  const fittedLeft = fitIdentifier(left);
  const fittedRight = fitIdentifier(right);
  expect(fittedLeft).not.toBe(fittedRight);
  expect(fittedLeft).not.toBe("a".repeat(POSTGRES_IDENTIFIER_MAX_BYTES));
  expect(utf8Bytes(fittedLeft)).toBeLessThanOrEqual(POSTGRES_IDENTIFIER_MAX_BYTES);
  expect(utf8Bytes(fittedRight)).toBeLessThanOrEqual(POSTGRES_IDENTIFIER_MAX_BYTES);
  expect(fitIdentifier(left)).toBe(fittedLeft);
});

test("multibyte names are cut on a character boundary", () => {
  const name = "é".repeat(40);
  expect(utf8Bytes(name)).toBeGreaterThan(POSTGRES_IDENTIFIER_MAX_BYTES);
  const fitted = fitIdentifier(name);
  expect(utf8Bytes(fitted)).toBeLessThanOrEqual(POSTGRES_IDENTIFIER_MAX_BYTES);
  expect(fitted).toContain("_");
});

test("namespace templates resolve with a sanitized id", () => {
  expect(resolveNamespace(templateNamespace("tenant_{id}"), "acme")).toBe("tenant_acme");
  expect(() => resolveNamespace(templateNamespace("tenant_{id}"), "ACME")).toThrow(/a-z0-9_/);
  expect(() => resolveNamespace(templateNamespace("tenant_{id}"), "a".repeat(60))).toThrow(/63/);
});

test("postgres truncation collides and the hash suffix does not, on PGlite", async () => {
  await withPgliteSchema(async (db) => {
    await assertTruncationCollides(async (statement) => {
      await db.exec(statement);
    });
  });
});

const decision = await loadPostgresGate();
requirePostgresWhenAsked(decision);

postgresTest(decision, "postgres truncation collides and the hash suffix does not", async () => {
  await withPostgresSchema(async (sql) => {
    await assertTruncationCollides(async (statement) => {
      await sql.unsafe(statement);
    });
  });
});

async function assertTruncationCollides(exec: (statement: string) => Promise<void>): Promise<void> {
  const left = `${"b".repeat(POSTGRES_IDENTIFIER_MAX_BYTES)}1`;
  const right = `${"b".repeat(POSTGRES_IDENTIFIER_MAX_BYTES)}2`;
  await exec(`create table ${quoteIdent(left)} (id int8)`);
  let collided = false;
  try {
    await exec(`create table ${quoteIdent(right)} (id int8)`);
  } catch {
    collided = true;
  }
  expect(collided).toBe(true);
  const fittedLeft = fitIdentifier(left);
  const fittedRight = fitIdentifier(right);
  expect(fittedLeft).not.toBe(fittedRight);
  await exec(`create table ${quoteIdent(fittedLeft)} (id int8)`);
  await exec(`create table ${quoteIdent(fittedRight)} (id int8)`);
}
