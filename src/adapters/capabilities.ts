/**
 * Driver capability registry.
 *
 * The flags are data (spec §4). A helper reads them. Spec section 21 has no
 * OKM11xx for a driver that lacks a flag: OKM1110 is the engine-version gate,
 * and OKM1801 is a dialect mismatch. This module does not invent a code and
 * does not throw for a missing flag.
 *
 * Each object is frozen. The `@__PURE__` mark lets a bundle drop the objects
 * it does not import. A bare `Object.freeze` keeps every object in this file.
 *
 * `stream` means the driver can open a server cursor. `.stream()` does not
 * read it. That method walks keyset batches on every driver.
 */

import type { DriverCapabilities } from "../contracts/driver.js";

/** Capability names a caller can read. */
export const CAPABILITY_NAMES = ["transactions", "stream", "listen", "cancel"] as const;

/** One name in {@link DriverCapabilities}. */
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/**
 * postgres.js execution flags.
 *
 * Interactive transactions, streaming, listen, and cancel. Statements use
 * the unnamed extended protocol so a plain execute is one round trip.
 * Named prepares are a connect option, not a flag.
 */
export const POSTGRESJS_CAPABILITIES = /* @__PURE__ */ Object.freeze({
  transactions: "interactive",
  stream: true,
  listen: true,
  cancel: true,
} as const satisfies DriverCapabilities);

/**
 * PGlite execution flags.
 *
 * A pool of one with interactive transactions and listen. `cancel` is
 * false: an in-flight statement cannot be aborted, and `statement_timeout`
 * is not enforced. The pool can describe a statement; that is not a flag.
 */
export const PGLITE_CAPABILITIES = /* @__PURE__ */ Object.freeze({
  transactions: "interactive",
  stream: false,
  listen: true,
  cancel: false,
} as const satisfies DriverCapabilities);

/**
 * node-postgres execution flags.
 *
 * Interactive transactions, cursor streaming, listen, and cancel are set
 * because the conformance suite passes them. `pg` cannot describe a
 * statement without running it, so the suite skips that case.
 * Parameterized queries use the unnamed extended protocol.
 */
export const NODE_POSTGRES_CAPABILITIES = /* @__PURE__ */ Object.freeze({
  transactions: "interactive",
  stream: true,
  listen: true,
  cancel: true,
} as const satisfies DriverCapabilities);

/**
 * Bun.sql execution flags.
 *
 * Interactive transactions, cursor streaming, and listen pass the conformance
 * suite. `cancel` is false: `Query.cancel()` does not abort the backend
 * (Bun 1.4), so the cancel and in-flight timeout cases are skipped.
 * Bun.sql has no describe API, so that case is skipped. RAISE NOTICE is not
 * surfaced, so the notice case is skipped. `prepare` is off, so a
 * parameterized query does not leave a named statement.
 */
export const BUNSQL_CAPABILITIES = /* @__PURE__ */ Object.freeze({
  transactions: "interactive",
  stream: true,
  listen: true,
  cancel: false,
} as const satisfies DriverCapabilities);

/**
 * Neon WebSocket pool execution flags.
 *
 * Interactive transactions pass on a direct connection. `stream`, `listen`,
 * and `cancel` stay false: a server cursor, `LISTEN`, and a side-channel
 * cancel are session features the pooler does not keep. The client has no
 * describe API. Statements use the unnamed protocol. `prepared: "named"`
 * is a connect option and is not for a transaction-mode pooler.
 */
export const NEON_WEBSOCKET_CAPABILITIES = /* @__PURE__ */ Object.freeze({
  transactions: "interactive",
  stream: false,
  listen: false,
  cancel: false,
} as const satisfies DriverCapabilities);

/**
 * Neon HTTP execution flags.
 *
 * One request is one statement. `sql.transaction` is the atomic batch.
 * There is no interactive `tx()`, no `LISTEN`, no server cursor, and no
 * cancel of a statement the server has already started.
 */
export const NEON_HTTP_CAPABILITIES = /* @__PURE__ */ Object.freeze({
  transactions: "batch",
  stream: false,
  listen: false,
  cancel: false,
} as const satisfies DriverCapabilities);

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
 * `transactions` is not boolean. Use {@link readCapability} for it.
 *
 * @param flags - Declared capabilities
 * @param name - `stream`, `listen`, or `cancel`
 * @returns The flag
 */
export function hasCapability(
  flags: DriverCapabilities,
  name: "stream" | "listen" | "cancel",
): boolean {
  return flags[name];
}
