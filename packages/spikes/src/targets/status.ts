/**
 * Per-target migration status, and the runtime compatibility check.
 *
 * A tenant behind by expand still works. A tenant behind by contract fails
 * closed for that tenant only (OKM1520).
 */

import { TargetError } from "./error.js";
import type { TargetPlan } from "./plan.js";
import type { Target } from "./target.js";

/** States `okm migrate status` shows. `protected` is a separate flag. */
export type StatusState = "current" | "behind-expand" | "behind-contract" | "ahead" | "failed";

/** One status row. */
export type StatusRow = {
  readonly name: string;
  readonly state: StatusState;
  readonly protected: boolean;
  readonly checkpoint: string | null;
  readonly error: string | null;
};

/**
 * Compares applied step ids with the plan.
 *
 * @param target - Logical destination
 * @param applied - Step ids recorded in the target's history
 * @param plan - Plan the code wants
 * @param failed - Set when the last run stopped on this target
 * @returns The status row
 */
export function migrationStatus(
  target: Target,
  applied: readonly string[],
  plan: TargetPlan,
  failed?: { readonly step: string | null; readonly error: string | null },
): StatusRow {
  if (failed?.error) {
    return {
      name: target.name,
      state: "failed",
      protected: target.protected,
      checkpoint: failed.step,
      error: failed.error,
    };
  }
  const wanted = plan.steps.filter((step) => step.scope === target.class);
  const wantedIds = new Set(wanted.map((step) => step.id));
  const have = new Set(applied);
  const ahead = applied.filter((id) => !wantedIds.has(id));
  if (ahead.length > 0) {
    return row(target, "ahead", applied.at(-1) ?? null, null);
  }
  const missing = wanted.filter((step) => !have.has(step.id));
  if (missing.length === 0) return row(target, "current", applied.at(-1) ?? null, null);
  if (missing.some((step) => step.class !== "contract")) {
    return row(target, "behind-expand", applied.at(-1) ?? null, null);
  }
  return row(target, "behind-contract", applied.at(-1) ?? null, null);
}

/**
 * Fails closed when a tenant is behind by a contract migration.
 *
 * Missing expand migrations do not throw.
 *
 * @param applied - Step ids in the tenant's history
 * @param plan - Plan the running code expects
 */
export function assertTenantCompatible(applied: readonly string[], plan: TargetPlan): void {
  const have = new Set(applied);
  const missingContract = plan.steps.some(
    (step) => step.scope === "tenant" && step.class === "contract" && !have.has(step.id),
  );
  if (!missingContract) return;
  throw new TargetError(
    "OKM1520",
    "Tenant is behind by a contract migration. This tenant fails closed until it catches up.",
  );
}

function row(
  target: Target,
  state: StatusState,
  checkpoint: string | null,
  error: string | null,
): StatusRow {
  return { name: target.name, state, protected: target.protected, checkpoint, error };
}
