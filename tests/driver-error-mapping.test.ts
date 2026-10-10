/**
 * Driver error mapping: undefined table and column (QA-L8), TLS (QA-L9),
 * and a driver message that is never empty (QA-M1).
 *
 * These tests build driver errors by hand. The Postgres suites cover the same
 * SQLSTATEs from a live server.
 */

import { expect, test } from "bun:test";

import { mapDriverError } from "../src/adapters/error.js";
import { mapPostgresError } from "../src/dialects/pg/errors.js";

function sqlError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

test("42P01 maps to undefined_table with a migration fix (QA-L8)", () => {
  const mapped = mapPostgresError(
    mapDriverError(sqlError('relation "notes" does not exist', "42P01")),
  );
  expect(mapped.fieldReason).toBe("undefined_table");
  expect(mapped.fix.summary).toContain("okm migrate apply");
  expect(mapped.fix.summary).toContain("okm migrate status");
});

test("42703 maps to undefined_column with a migration fix (QA-L8)", () => {
  const mapped = mapPostgresError(
    mapDriverError(sqlError('column "title" does not exist', "42703")),
  );
  expect(mapped.fieldReason).toBe("undefined_column");
  expect(mapped.fix.summary).toContain("okm migrate apply");
});

test("a refresh failure keeps kind driver and names the fix", () => {
  const owner = mapPostgresError(
    mapDriverError(sqlError("permission denied for materialized view v", "42501")),
  );
  expect(owner.kind).toBe("driver");
  expect(owner.fieldReason).toBe("not_owner");
  expect(owner.fix.summary).toContain("owner of the materialized view");
});

test.each([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_POSTGRES_TLS_NOT_AVAILABLE",
])("a TLS failure %s maps to unavailable with reason tls (QA-L9)", (code) => {
  const tls = Object.assign(new Error("certificate failed"), { code });
  const mapped = mapPostgresError(mapDriverError(tls));
  expect(mapped.kind).toBe("unavailable");
  expect(mapped.fieldReason).toBe("tls");
  expect(mapped.fix.summary).toContain("sslmode");
});

test("a driver error with an empty message still has a message (QA-M1)", () => {
  const mapped = mapDriverError(new AggregateError([], ""));
  expect(mapped).toBeInstanceOf(Error);
  expect((mapped as Error).message.length).toBeGreaterThan(0);
});

test("an AggregateError with an empty message takes the first inner message (QA-M1)", () => {
  const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
    code: "ECONNREFUSED",
  });
  const mapped = mapDriverError(new AggregateError([inner], ""));
  expect((mapped as Error).message).toContain("ECONNREFUSED");
});
