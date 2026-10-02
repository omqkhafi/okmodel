/**
 * Capability registry reads flags. It does not throw: spec section 21 has no
 * OKM11xx for a driver that lacks a flag.
 */

import { expect, test } from "bun:test";

import {
  hasCapability,
  PGLITE_CAPABILITIES,
  POSTGRESJS_CAPABILITIES,
  readCapability,
} from "../src/adapters/capabilities.js";

test("readCapability returns the declared flag", () => {
  expect(readCapability(POSTGRESJS_CAPABILITIES, "transactions")).toBe("interactive");
  expect(readCapability(POSTGRESJS_CAPABILITIES, "prepared")).toBe("unnamed");
  expect(readCapability(POSTGRESJS_CAPABILITIES, "cancel")).toBe(true);
  expect(readCapability(PGLITE_CAPABILITIES, "cancel")).toBe(false);
  expect(readCapability(PGLITE_CAPABILITIES, "stream")).toBe(false);
  expect(hasCapability(PGLITE_CAPABILITIES, "describe")).toBe(true);
  expect(hasCapability(PGLITE_CAPABILITIES, "listen")).toBe(true);
});
