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
 * node-postgres execution flags.
 *
 * Interactive transactions, cursor streaming, listen, and cancel are set
 * because the conformance suite passes them. Describe is false: `pg` cannot
 * describe a statement without running it, and that case is skipped.
 * Parameterized queries use the unnamed extended protocol.
 */
export const NODE_POSTGRES_CAPABILITIES = {
  transactions: "interactive",
  stream: true,
  listen: true,
  cancel: true,
  prepared: "unnamed",
  describe: false,
} as const satisfies DriverCapabilities;

/**
 * Bun.sql execution flags.
 *
 * Interactive transactions, cursor streaming, and listen pass the conformance
 * suite. `cancel` is false: `Query.cancel()` does not abort the backend
 * (Bun 1.4), so the cancel and in-flight timeout cases are skipped.
 * `describe` is false: Bun.sql has no describe API. RAISE NOTICE is not
 * surfaced, so the notice case is skipped. `prepare` is off, so a
 * parameterized query does not leave a named statement.
 */
export const BUNSQL_CAPABILITIES = {
  transactions: "interactive",
  stream: true,
  listen: true,
  cancel: false,
  prepared: "unnamed",
  describe: false,
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
