/**
 * Driver capability registry.
 *
 * The flags are data (spec §4). A helper reads them. Spec section 21 has no
 * OKM11xx for a driver that lacks a flag: OKM1110 is the engine-version gate,
 * and OKM1801 is a dialect mismatch. This module does not invent a code and
 * does not throw for a missing flag.
 */

import type { DriverCapabilities } from "../contracts/driver.js";

/** Capability names a caller can read. */
export const CAPABILITY_NAMES = [
  "transactions",
  "stream",
  "listen",
  "cancel",
  "prepared",
  "describe",
] as const;

/** One name in {@link DriverCapabilities}. */
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/**
 * postgres.js execution flags.
 *
 * Interactive transactions, streaming, listen, cancel, and describe.
 * Statements use the unnamed extended protocol so a plain execute is one
 * round trip. Named prepares are a later opt-in.
 */
export const POSTGRESJS_CAPABILITIES = {
  transactions: "interactive",
  stream: true,
  listen: true,
  cancel: true,
  prepared: "unnamed",
  describe: true,
} as const satisfies DriverCapabilities;

/**
 * PGlite execution flags.
 *
 * A pool of one with interactive transactions, listen, and describe.
 * `cancel` is false: an in-flight statement cannot be aborted, and
 * `statement_timeout` is not enforced.
 */
export const PGLITE_CAPABILITIES = {
  transactions: "interactive",
  stream: false,
  listen: true,
  cancel: false,
  prepared: "unnamed",
  describe: true,
} as const satisfies DriverCapabilities;

/**
 * Reads one capability flag.
 *
 * @param flags - Declared capabilities
 * @param name - Flag name
 * @returns The flag value
 */
export function readCapability<Name extends CapabilityName>(
  flags: DriverCapabilities,
  name: Name,
): DriverCapabilities[Name] {
  return flags[name];
}

/**
 * Reports whether a boolean capability is set.
 *
 * `transactions` and `prepared` are not boolean. Use {@link readCapability}
 * for those.
 *
 * @param flags - Declared capabilities
 * @param name - `stream`, `listen`, `cancel`, or `describe`
 * @returns The flag
 */
export function hasCapability(
  flags: DriverCapabilities,
  name: "stream" | "listen" | "cancel" | "describe",
): boolean {
  return flags[name];
}
