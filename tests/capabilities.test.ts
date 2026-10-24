/**
 * Capability registry reads flags. It does not throw: spec section 21 has no
 * OKM11xx for a driver that lacks a flag.
 */

import { expect, test } from "bun:test";

import {
  BUNSQL_CAPABILITIES,
  CAPABILITY_NAMES,
  hasCapability,
  NEON_HTTP_CAPABILITIES,
  NEON_WEBSOCKET_CAPABILITIES,
  NODE_POSTGRES_CAPABILITIES,
  PGLITE_CAPABILITIES,
  POSTGRESJS_CAPABILITIES,
  readCapability,
} from "../src/adapters/capabilities.js";
import type { DriverCapabilities, DriverPool } from "../src/contracts/driver.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { createClient } from "../src/runtime/client.js";
import {
  capabilities as neonCapabilities,
  httpCapabilities as neonHttpCapabilities,
} from "../src/runtime/pg/neon.js";

const ADAPTERS = [
  ["postgres.js", POSTGRESJS_CAPABILITIES],
  ["pglite", PGLITE_CAPABILITIES],
  ["node-postgres", NODE_POSTGRES_CAPABILITIES],
  ["bun.sql", BUNSQL_CAPABILITIES],
  ["neon websocket", NEON_WEBSOCKET_CAPABILITIES],
  ["neon http", NEON_HTTP_CAPABILITIES],
] as const;

test("the connected client exposes the pool capabilities object", async () => {
  const notes = table("notes", { id: t.text().primaryKey() });
  const pool: DriverPool = {
    capabilities: POSTGRESJS_CAPABILITIES,
    execute: () =>
      Promise.resolve({
        rows: [["170000", "PostgreSQL 17.0", null]],
        count: 1,
        notices: [],
      }),
    batch: () => Promise.resolve([]),
    stats: () => ({ size: 1, idle: 1, inflight: 0, waiting: 0 }),
    close: () => Promise.resolve(),
  };
  const db = createClient(schema({ tables: [notes] }), pool, { ownsPool: false });
  expect(db.capabilities).toBe(POSTGRESJS_CAPABILITIES);
  await db.connected;
});

test("readCapability returns the declared flag", () => {
  expect(readCapability(POSTGRESJS_CAPABILITIES, "transactions")).toBe("interactive");
  expect(readCapability(POSTGRESJS_CAPABILITIES, "cancel")).toBe(true);
  expect(readCapability(PGLITE_CAPABILITIES, "cancel")).toBe(false);
  expect(readCapability(PGLITE_CAPABILITIES, "stream")).toBe(false);
  expect(hasCapability(PGLITE_CAPABILITIES, "listen")).toBe(true);
  expect(hasCapability(NEON_HTTP_CAPABILITIES, "stream")).toBe(false);
});

test("every adapter capabilities object names only the shared flags", () => {
  for (const [name, flags] of ADAPTERS) {
    expect(Object.keys(flags).sort(), name).toEqual([...CAPABILITY_NAMES].sort());
    assertCapabilities(flags);
  }
});

test("adapter capability objects are frozen", () => {
  for (const [name, flags] of ADAPTERS) {
    expect(Object.isFrozen(flags), name).toBe(true);
    expect(() => {
      (flags as { stream: boolean }).stream = !flags.stream;
    }, name).toThrow(TypeError);
  }
});

test("neon entry re-exports the shared websocket and http capabilities", () => {
  expect(neonCapabilities).toEqual(NEON_WEBSOCKET_CAPABILITIES);
  expect(neonHttpCapabilities).toEqual(NEON_HTTP_CAPABILITIES);
  expect(neonCapabilities).toEqual({
    transactions: "interactive",
    stream: false,
    listen: false,
    cancel: false,
  });
  expect(neonHttpCapabilities).toEqual({
    transactions: "batch",
    stream: false,
    listen: false,
    cancel: false,
  });
});

function assertCapabilities(flags: DriverCapabilities): void {
  expect(flags.transactions === "interactive" || flags.transactions === "batch").toBe(true);
  expect(typeof flags.stream).toBe("boolean");
  expect(typeof flags.listen).toBe("boolean");
  expect(typeof flags.cancel).toBe("boolean");
}
