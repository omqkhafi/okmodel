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

test("B-33: a non-sensitive table still reports detail on cause", () => {
  const detail = "Key (email)=(ada@example.com) already exists.";
  const mapped = mapPostgresError(
    new DriverError("duplicate key value violates unique constraint", {
      sqlstate: "23505",
      constraint: "plain_email_key",
      table: "plain",
      detail,
      cause: Object.assign(new Error(detail), { detail }),
    }),
    { schema: app },
  );
  expect(mapped.kind).toBe("unique");
  expect(mapped.message.includes("ada@example.com")).toBe(false);
  const cause = mapped.cause;
  expect(cause).toBeDefined();
  expect(inspect(cause, { depth: 10 })).toContain("ada@example.com");
});

test("B-33: includeValues keeps the full cause as an opt-in", () => {
  const mapped = mapPostgresError(
    new DriverError("duplicate", {
      sqlstate: "23505",
      constraint: "secrets_secret_key",
      table: "secrets",
      detail: `Key (secret)=(${SECRET}) already exists.`,
      cause: Object.assign(new Error(SECRET), { detail: SECRET }),
    }),
    { schema: app, includeValues: true },
  );
  expect(mapped.values()).toEqual({ secret: SECRET });
  expect(inspect(mapped.cause, { depth: 10 })).toContain(SECRET);
});
