/**
 * Words shared by `connect()` and `okm migrate status` (D197).
 *
 * The startup check and the status command name the same situations.
 * A failed step adds the resume hint status prints.
 */

/** The database and the app record the same catalog. */
export const CURRENT = "current";

/** Pending migrations are expand only. */
export const BEHIND_EXPAND = "behind by expand";

/** A pending migration is not expand. */
export const BEHIND_CONTRACT = "behind by contract";

/** The database has expand migrations the app does not. */
export const AHEAD_EXPAND = "ahead by expand";

/** The database has a contract migration the app does not. */
export const AHEAD_CONTRACT = "ahead by contract";

/**
 * Status text for a migration that stopped mid-way.
 *
 * @param step - Zero-based step that has no `okm_history` row
 * @returns The state, including the resume hint
 */
export function failedAt(step: number): string {
  return `failed at step ${String(step)} (resume with okm migrate apply)`;
}
