/**
 * Lost-connection classification uses driver codes and SQLSTATE only.
 *
 * A server error whose text contains CONNECT, connection, or closed is not a
 * lost connection. These cases fail while classification still reads the message.
 */

import { expect, test } from "bun:test";

import { DriverError } from "../src/adapters/error.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { isConnectionFailure, isConnectionLost } from "../src/contracts/connection.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { connect as connectPglite } from "../src/runtime/pg/pglite.js";

function coded(message: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error(message), fields);
}

const lost: readonly (readonly [string, Record<string, unknown>])[] = [
  ["CONNECT_TIMEOUT", { code: "CONNECT_TIMEOUT" }],
  ["CONNECTION_CLOSED", { code: "CONNECTION_CLOSED" }],
  ["CONNECTION_ENDED", { code: "CONNECTION_ENDED" }],
  ["CONNECTION_DESTROYED", { code: "CONNECTION_DESTROYED" }],
  ["ECONNRESET", { code: "ECONNRESET" }],
  ["ECONNREFUSED", { code: "ECONNREFUSED" }],
  ["EPIPE", { code: "EPIPE" }],
  ["ETIMEDOUT", { code: "ETIMEDOUT" }],
  ["SQLSTATE 08006", { code: "08006" }],
  ["SQLSTATE 08001", { sqlstate: "08001" }],
  ["SQLSTATE 57P01", { code: "57P01" }],
  ["SQLSTATE 57P02", { code: "57P02" }],
  ["SQLSTATE 57P03", { code: "57P03" }],
  ["Bun.sql closed", { code: "ERR_POSTGRES_CONNECTION_CLOSED" }],
  ["Bun.sql admin shutdown", { code: "ERR_POSTGRES_SERVER_ERROR", errno: "57P01" }],
  [
    "CONNECT_TIMEOUT on the cause",
    {
      cause: coded("write CONNECT_TIMEOUT 127.0.0.1:1", { code: "CONNECT_TIMEOUT" }),
    },
  ],
];

const kept: readonly (readonly [string, Record<string, unknown>])[] = [
  ["check constraint no_CONNECT_zz", { code: "23514", constraint: "no_CONNECT_zz" }],
  [
    "grant CONNECT on a table",
    { code: "0LP01", message: "invalid privilege type CONNECT for table" },
  ],
  ["permission denied for CONNECT", { sqlstate: "42501" }],
  ["too many connections", { code: "53300" }],
  ["Bun.sql check on errno", { code: "ERR_POSTGRES_SERVER_ERROR", errno: "23514" }],
  ["message CONNECT and no code", {}],
  ["message connection closed", {}],
  ["message Connection terminated unexpectedly", {}],
  ["message terminating connection", {}],
  ["message The pool is closed", {}],
  [
    "server SQLSTATE vetoes a lost cause",
    {
      sqlstate: "23514",
      cause: coded("ECONNRESET", { code: "ECONNRESET" }),
    },
  ],
];

for (const [name, fields] of lost) {
  test(`${name} is a lost connection`, () => {
    const error = coded(name, fields);
    expect(isConnectionFailure(error)).toBe(true);
    expect(isConnectionLost(error)).toBe(true);
  });
}

for (const [name, fields] of kept) {
  test(`${name} is not a lost connection`, () => {
    const message = typeof fields.message === "string" ? fields.message : name;
    const error = coded(message, fields);
    expect(isConnectionFailure(error)).toBe(false);
    expect(isConnectionLost(error)).toBe(false);
  });
}

test("a check error whose message contains CONNECT is not lost through its cause", () => {
  const server = coded('new row violates check constraint "no_CONNECT_zz"', {
    code: "23514",
    constraint: "no_CONNECT_zz",
  });
  const wrapped = new Error("step failed", { cause: server });
  expect(isConnectionFailure(wrapped)).toBe(false);
  expect(isConnectionLost(wrapped)).toBe(false);
});

const notes = table("notes", { id: t.integer().primaryKey(), title: t.text() });
const app = schema({ tables: [notes] });

test("PGlite rejects a CONNECT server error from batch, tx, and a grant", async () => {
  const pool = await openPglite();
  try {
    await pool.execute(`create table notes (
        id integer primary key,
        title text not null,
        constraint "no_CONNECT_zz" check (id > 0)
      )`);
    const db = await connectPglite(pool, { schema: app });
    await db.connected;
    await expectCheck(db.batch([db.notes.insert({ id: 0, title: "no" })]));
    expect(await db.notes.find({ limit: 1 })).toEqual([]);
    await expectCheck(
      db.tx(async (tx) => {
        await tx.notes.insert({ id: 0, title: "no" });
      }),
    );
    expect(await db.notes.find({ limit: 1 })).toEqual([]);
    if (pool.reserve === undefined) throw new Error("PGlite cannot reserve a connection");
    const conn = await pool.reserve();
    try {
      await conn.execute("begin");
      const error = await rejected(conn.execute("grant CONNECT on table public.notes to public"));
      expect(isConnectionLost(error)).toBe(false);
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) expect(error.message.includes("CONNECT")).toBe(true);
    } finally {
      await conn.release();
    }
    expect(await db.notes.find({ limit: 1 })).toEqual([]);
  } finally {
    await pool.close();
  }
}, 10_000);

test("a closed pool is lost and says the pool is closed", async () => {
  const pool = await openPglite();
  await pool.close();
  const error = await rejected(pool.execute("select 1"));
  expect(error).toBeInstanceOf(DriverError);
  if (error instanceof DriverError) {
    expect(error.message).toBe("The pool is closed.");
    expect(error.sqlstate).toBe("08006");
  }
  expect(isConnectionLost(error)).toBe(true);
});

async function expectCheck(pending: Promise<unknown>): Promise<void> {
  const error = await rejected(pending);
  expect(isConnectionLost(error)).toBe(false);
  expect(error).toBeInstanceOf(OkmError);
  if (error instanceof OkmError) {
    expect(error.kind).toBe("check");
    expect(error.constraint).toBe("no_CONNECT_zz");
  }
}

async function rejected(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error("expected the statement to fail");
}
