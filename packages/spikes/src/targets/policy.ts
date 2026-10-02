/**
 * Protected-target policy.
 *
 * One function for every entry point. `drop` and `rollback` are refused on
 * every target: OKModel never drops a database, and migrations are forward-only.
 * There is no down migration.
 */

import { TargetError } from "./error.js";

/** Operation classes the policy knows. */
export type OperationClass =
  | "plan"
  | "status"
  | "check"
  | "drift"
  | "verify"
  | "pull"
  | "catalog-export"
  | "inspect"
  | "expand"
  | "reference"
  | "provision"
  | "contract"
  | "unclassified"
  | "push"
  | "backfill"
  | "seed"
  | "history-repair"
  | "drop"
  | "rollback";

/** Every class, in the order the matrix test walks them. */
export const OPERATION_CLASSES = [
  "plan",
  "status",
  "check",
  "drift",
  "verify",
  "pull",
  "catalog-export",
  "inspect",
  "expand",
  "reference",
  "provision",
  "contract",
  "unclassified",
  "push",
  "backfill",
  "seed",
  "history-repair",
  "drop",
  "rollback",
] as const satisfies readonly OperationClass[];

const READ_ONLY = new Set<OperationClass>([
  "plan",
  "status",
  "check",
  "drift",
  "verify",
  "pull",
  "catalog-export",
  "inspect",
]);

/**
 * Whether an operation may run.
 *
 * Unprotected targets allow everything except `drop` and `rollback`.
 * Protected targets allow read-only work, `expand`, `reference`, and
 * `provision` only when the target is empty. `--allow-protected` lifts the
 * protected blocks. It does not allow `drop` or `rollback`.
 *
 * @param target - Protection flag
 * @param operation - Operation class
 * @param options - Empty target, and the per-invocation override
 * @returns Allow or block
 */
export function policyDecision(
  target: { readonly protected: boolean },
  operation: OperationClass,
  options?: { readonly allowProtected?: boolean; readonly empty?: boolean },
): "allow" | "block" {
  if (operation === "drop" || operation === "rollback") return "block";
  if (!target.protected) return "allow";
  if (options?.allowProtected === true) return "allow";
  if (READ_ONLY.has(operation)) return "allow";
  if (operation === "expand" || operation === "reference") return "allow";
  if (operation === "provision") return options?.empty === true ? "allow" : "block";
  return "block";
}

/**
 * Refuses a blocked operation with OKM1850.
 *
 * @param target - Protection flag
 * @param operation - Operation class
 * @param options - Empty target, and the per-invocation override
 */
export function assertTargetPolicy(
  target: { readonly protected: boolean },
  operation: OperationClass,
  options?: { readonly allowProtected?: boolean; readonly empty?: boolean },
): void {
  if (policyDecision(target, operation, options) === "allow") return;
  const override =
    target.protected && operation !== "drop" && operation !== "rollback"
      ? " Pass --allow-protected to run it on this target."
      : "";
  throw new TargetError(
    "OKM1850",
    `${operation} is blocked on ${target.protected ? "a protected" : "an"} target.${override}`,
  );
}
