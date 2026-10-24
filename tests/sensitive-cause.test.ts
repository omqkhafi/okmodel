/**
 * Sensitive tables keep values out of error.cause (B-33).
 *
 * Unit coverage for the mapper. Live adapters are in sensitive-cause-pg.test.ts.
 */

import { expect, test } from "bun:test";
import { inspect } from "node:util";

import { DriverError } from "../src/adapters/error.js";
import { OkmError } from "../src/contracts/error.js";
import { mapPostgresError } from "../src/dialects/pg/errors.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";

const SECRET = "TOPSECRET-123";

const secrets = table("secrets", {
  id: id({ default: "none" }),
  secret: text().sensitive(),
});
const plain = table("plain", {
  id: id({ default: "none" }),
  email: text(),
});
const app = schema({ casing: "snake", tables: [secrets, plain] });

function leakNowhere(error: OkmError, value: string): void {
  expect(error.message.includes(value)).toBe(false);
  expect(String(error).includes(value)).toBe(false);
  expect(JSON.stringify(error).includes(value)).toBe(false);
  expect(inspect(error, { depth: 10 }).includes(value)).toBe(false);
  const cause = error.cause;
  if (cause === undefined || cause === null) return;
  expect(inspect(cause, { depth: 10 }).includes(value)).toBe(false);
  expect(JSON.stringify(cause).includes(value)).toBe(false);
  if (typeof cause === "object") {
    for (const key of Reflect.ownKeys(cause)) {
      const held = Reflect.get(cause, key);
      if (typeof held === "string") expect(held.includes(value)).toBe(false);
      else expect(inspect(held, { depth: 10 }).includes(value)).toBe(false);
    }
  }
}

test("B-33: a unique violation on a sensitive table keeps values out of cause", () => {
  const mapped = mapPostgresError(
    new DriverError("duplicate key value violates unique constraint", {
      sqlstate: "23505",
      constraint: "secrets_secret_key",
      table: "secrets",
      detail: `Key (secret)=(${SECRET}) already exists.`,
      cause: Object.assign(new Error(`Key (secret)=(${SECRET}) already exists.`), {
        code: "23505",
        detail: `Key (secret)=(${SECRET}) already exists.`,
        where: `Failing row contains (${SECRET}).`,
      }),
    }),
    { schema: app },
  );
  expect(mapped.kind).toBe("unique");
  leakNowhere(mapped, SECRET);
  expect(mapped.cause).toMatchObject({
    name: "DriverError",
    sqlstate: "23505",
    table: "secrets",
    constraint: "secrets_secret_key",
    code: "23505",
  });
  expect(mapped.cause).not.toHaveProperty("detail");
  expect(mapped.cause).not.toHaveProperty("where");
  expect(mapped.cause).not.toHaveProperty("message");
});

test("E-1: a non-sensitive table omits bound values unless includeValues", () => {
  const detail = "Key (email)=(ada@example.com) already exists.";
  const driver = new DriverError("duplicate key value violates unique constraint", {
    sqlstate: "23505",
    constraint: "plain_email_key",
    table: "plain",
    detail,
    cause: Object.assign(new Error(detail), { detail, parameters: ["ada@example.com"] }),
  });
  const mapped = mapPostgresError(driver, { schema: app });
  expect(mapped.kind).toBe("unique");
  expect(mapped.message.includes("ada@example.com")).toBe(false);
  expect(mapped.values()).toBeUndefined();
  expect(mapped.cause).not.toHaveProperty("parameters");
  expect(mapped.cause).not.toHaveProperty("detail");
  expect(inspect(mapped.cause, { depth: 10 })).not.toContain("ada@example.com");

  const opted = mapPostgresError(driver, { schema: app, includeValues: true });
  expect(opted.values()).toEqual({ email: "ada@example.com" });
  expect(inspect(opted.cause, { depth: 10 })).toContain("ada@example.com");
});

test("E-1: includeValues still redacts a sensitive column", () => {
  const mapped = mapPostgresError(
    new DriverError("duplicate", {
      sqlstate: "23505",
      constraint: "secrets_secret_key",
      table: "secrets",
      detail: `Key (secret)=(${SECRET}) already exists.`,
      cause: Object.assign(new Error(SECRET), {
        detail: SECRET,
        parameters: [SECRET],
      }),
    }),
    { schema: app, includeValues: true },
  );
  expect(mapped.values()).toBeUndefined();
  leakNowhere(mapped, SECRET);
  expect(mapped.cause).not.toHaveProperty("parameters");
  expect(mapped.cause).not.toHaveProperty("detail");
});

function pgjsCause(message: string, code: string, value: string): Error {
  const cause = Object.assign(new Error(message), { code });
  Object.defineProperty(cause, "parameters", { value: [value], enumerable: false });
  Object.defineProperty(cause, "args", { value: [value], enumerable: false });
  return cause;
}

test("B-33 residual: generic driver error with statement table strips parameters and args", () => {
  const mapped = mapPostgresError(
    new DriverError('invalid input syntax for type integer: "x"', {
      sqlstate: "22P02",
      cause: pgjsCause('invalid input syntax for type integer: "x"', "22P02", SECRET),
    }),
    { schema: app, table: "secrets" },
  );
  expect(mapped.kind).toBe("invalid");
  leakNowhere(mapped, SECRET);
  expect(mapped.cause).not.toHaveProperty("parameters");
  expect(mapped.cause).not.toHaveProperty("args");
});

test("B-33 residual: aborted connection stamped okmTable strips parameters and args", () => {
  const driver = new DriverError("write CONNECTION_CLOSED 127.0.0.1:55432", {
    sqlstate: "08006",
    cause: pgjsCause("write CONNECTION_CLOSED 127.0.0.1:55432", "CONNECTION_CLOSED", SECRET),
  });
  Reflect.set(driver, "okmTable", "secrets");
  const mapped = mapPostgresError(driver, { schema: app });
  expect(mapped.kind).toBe("unavailable");
  leakNowhere(mapped, SECRET);
  expect(mapped.cause).not.toHaveProperty("parameters");
  expect(mapped.cause).not.toHaveProperty("args");
});

test("E-1: a non-sensitive statement omits parameters unless includeValues", () => {
  const driver = new DriverError('invalid input syntax for type integer: "x"', {
    sqlstate: "22P02",
    cause: pgjsCause('invalid input syntax for type integer: "x"', "22P02", "ada@example.com"),
  });
  Reflect.set(driver, "okmTable", "plain");
  const mapped = mapPostgresError(driver, { schema: app });
  expect(mapped.kind).toBe("invalid");
  expect(mapped.cause).not.toHaveProperty("parameters");
  expect(inspect(mapped.cause, { depth: 10, showHidden: true })).not.toContain("ada@example.com");

  const opted = mapPostgresError(driver, { schema: app, includeValues: true });
  expect(inspect(opted.cause, { depth: 10, showHidden: true })).toContain("ada@example.com");
});
