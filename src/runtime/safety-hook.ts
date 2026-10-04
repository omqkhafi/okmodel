/**
 * Slot the read path calls before planning.
 *
 * Empty until `okmodel/safety` registers a rule. The application startup
 * graph pays for this call and not for the registry.
 */

/** One recorded contribution. */
export type SafetyContribution = {
  readonly rule: string;
  readonly contribution: string;
  readonly provenance: string;
  readonly source?: string;
};

/** A named escape hatch with a reason. */
export type SafetyHatch = {
  readonly name: "unscoped" | "all" | "trusted" | "allow";
  readonly reason: string;
};

/** Installed by the safety registry. Absent until a rule is registered. */
export type SafetyHook = (
  contributions: readonly SafetyContribution[],
  hatches: readonly SafetyHatch[] | undefined,
) => void;

let hook: SafetyHook | undefined;

/**
 * Reports whether a safety rule is registered.
 *
 * @returns `true` after the first {@link installSafetyHook} until the last rule is removed
 */
export function safetyInstalled(): boolean {
  return hook !== undefined;
}

/**
 * Installs or clears the verifier the read path calls.
 *
 * @param next - Verifier, or `undefined` to remove it
 */
export function installSafetyHook(next: SafetyHook | undefined): void {
  hook = next;
}

/**
 * Runs the installed verifier.
 *
 * A no-op when nothing is registered, and it does not allocate in that case
 * because the caller returns first.
 *
 * @param contributions - Rules already recorded for this query
 * @param hatches - Escape hatches the caller passed
 */
export function runSafety(
  contributions: readonly SafetyContribution[],
  hatches: readonly SafetyHatch[] | undefined,
): void {
  hook?.(contributions, hatches);
}
