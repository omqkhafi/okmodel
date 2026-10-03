/**
 * SQLSTATE mapping for each driver's error shape.
 */

import { expect, test } from "bun:test";

import { DriverError, mapDriverError } from "../src/adapters/error.js";

test("node-postgres code is the sqlstate", () => {
  const error = Object.assign(new Error("duplicate key"), {
    code: "23505",
    constraint: "notes_email_taken_key",
    table: "notes",
    column: "email",
    detail: "Key (email)=(ada@example.com) already exists.",
  });
  const mapped = mapDriverError(error);
  expect(mapped).toBeInstanceOf(DriverError);
  if (!(mapped instanceof DriverError)) return;
  expect(mapped.sqlstate).toBe("23505");
  expect(mapped.constraint).toBe("notes_email_taken_key");
  expect(mapped.table).toBe("notes");
  expect(mapped.column).toBe("email");
  expect(mapped.detail).toContain("ada@example.com");
});

test("bun.sql errno is the sqlstate", () => {
  const error = Object.assign(new Error("duplicate key"), {
    name: "PostgresError",
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: "23505",
    constraint: "notes_email_taken_key",
    table: "notes",
    detail: "Key (email)=(ada@example.com) already exists.",
  });
  const mapped = mapDriverError(error);
  expect(mapped).toBeInstanceOf(DriverError);
  if (!(mapped instanceof DriverError)) return;
  expect(mapped.sqlstate).toBe("23505");
  expect(mapped.constraint).toBe("notes_email_taken_key");
  expect(mapped.table).toBe("notes");
});
