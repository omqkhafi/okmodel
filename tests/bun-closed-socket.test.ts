/**
 * Bun.sql closed-socket text has no SQLSTATE. The session stamps 08006 before
 * it maps the rejection, so a scoped read counts the failure as unavailable
 * (N-56). A synchronous throw from send still leaves the session.
 */

import { expect, test } from "bun:test";

import { DriverError } from "../src/adapters/error.js";
import { noticeBuffer, WireSession, type WireQuery } from "../src/adapters/pg/session.js";
import { mapPostgresError } from "../src/dialects/pg/errors.js";

test("bun.sql closed-socket text is unavailable before the session maps it", async () => {
  for (const message of [
    "Connection closed",
    "connection must be a PostgresSQLConnection",
  ] as const) {
    const error = await query(Promise.reject(new Error(message)));
    expect(error).toBeInstanceOf(DriverError);
    if (!(error instanceof DriverError)) return;
    expect(error.sqlstate).toBe("08006");
    expect(mapPostgresError(error).kind).toBe("unavailable");
  }
  const wrapped = await query(
    Promise.reject(
      new Error("query failed", {
        cause: new Error("connection must be a PostgresSQLConnection"),
      }),
    ),
  );
  expect(wrapped).toBeInstanceOf(DriverError);
  if (!(wrapped instanceof DriverError)) return;
  expect(wrapped.sqlstate).toBe("08006");
  expect(mapPostgresError(wrapped).kind).toBe("unavailable");
});

test("a synchronous send failure still ends the statement", async () => {
  let left = 0;
  const session = new WireSession(
    () => {
      throw new Error("connection must be a PostgresSQLConnection");
    },
    noticeBuffer(),
    () => false,
    false,
    () => undefined,
    () => {
      left += 1;
    },
  );
  const error = await session.query("begin read only", undefined, undefined).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(left).toBe(1);
  expect(error).toBeInstanceOf(DriverError);
});

function query(pending: Promise<unknown>): Promise<unknown> {
  let left = 0;
  const session = new WireSession(
    () => pending as WireQuery,
    noticeBuffer(),
    () => false,
    false,
    () => undefined,
    () => {
      left += 1;
    },
  );
  return session.query("begin read only", undefined, undefined).then(
    () => {
      expect(left).toBe(1);
      return undefined;
    },
    (error: unknown) => {
      expect(left).toBe(1);
      return error;
    },
  );
}
