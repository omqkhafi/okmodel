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
import type { DriverCapabilities } from "../src/contracts/driver.js";
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

test("readCapability returns the declared flag", () => {
  expect(readCapability(POSTGRESJS_CAPABILITIES, "transactions")).toBe("interactive");
  expect(readCapability(POSTGRESJS_CAPABILITIES, "prepared")).toBe("unnamed");
  expect(readCapability(POSTGRESJS_CAPABILITIES, "cancel")).toBe(true);
  expect(readCapability(PGLITE_CAPABILITIES, "cancel")).toBe(false);
  expect(readCapability(PGLITE_CAPABILITIES, "stream")).toBe(false);
  expect(hasCapability(PGLITE_CAPABILITIES, "describe")).toBe(true);
  expect(hasCapability(PGLITE_CAPABILITIES, "listen")).toBe(true);
});

test("every adapter capabilities object names only the shared flags", () => {
  for (const [name, flags] of ADAPTERS) {
    expect(Object.keys(flags).sort(), name).toEqual([...CAPABILITY_NAMES].sort());
    assertCapabilities(flags);
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
    prepared: "unnamed",
    describe: false,
  });
  expect(neonHttpCapabilities).toEqual({
    transactions: "batch",
    stream: false,
    listen: false,
    cancel: false,
    prepared: "none",
    describe: false,
  });
});

function assertCapabilities(flags: DriverCapabilities): void {
  expect(flags.transactions === "interactive" || flags.transactions === "batch").toBe(true);
  expect(typeof flags.stream).toBe("boolean");
  expect(typeof flags.listen).toBe("boolean");
  expect(typeof flags.cancel).toBe("boolean");
  expect(
    flags.prepared === "named" || flags.prepared === "unnamed" || flags.prepared === "none",
  ).toBe(true);
  expect(typeof flags.describe).toBe("boolean");
}
