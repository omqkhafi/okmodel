/**
 * Expand, contract, or raw SQL.
 *
 * `unclassified` is only for a statement the planner did not classify.
 * The protected-target policy treats that the same as `contract`.
 */
export type MigrationClass = "expand" | "contract" | "unclassified";

/**
 * One operation the planner can emit.
 *
 * A new kind belongs in {@link STEP_CLASS}. The classification test lists
 * every key, so a kind without a class fails that test.
 */
export const STEP_CLASS = {
  "create-table": "expand",
  "drop-table": "contract",
  "add-column": "expand",
  "add-column-required": "contract",
  "drop-column": "contract",
  "set-column-type": "contract",
  "set-not-null": "contract",
  "drop-not-null": "expand",
  "set-default": "expand",
  "drop-default": "contract",
  "add-identity": "expand",
  "drop-identity": "contract",
  "set-identity-always": "contract",
  "set-identity-by-default": "expand",
  "add-constraint": "expand",
  "validate-constraint": "expand",
  "drop-constraint": "contract",
  "drop-not-null-check": "expand",
  "rename-constraint": "contract",
  "widen-check": "expand",
  "narrow-check": "contract",
  "create-index": "expand",
  "drop-index": "contract",
  "rename-index": "contract",
  "create-sequence": "expand",
  "drop-sequence": "contract",
  "create-enum": "expand",
  "recreate-enum": "contract",
  "add-enum-value": "expand",
  "rename-enum": "contract",
  "drop-enum": "contract",
  "set-enum-column": "contract",
  "create-domain": "expand",
  "drop-domain": "contract",
  "add-domain-check": "expand",
  "validate-domain-check": "expand",
  "drop-domain-check": "contract",
  "rename-domain-check": "expand",
  "create-extension": "expand",
  "drop-extension": "contract",
  "update-extension": "expand",
  "move-extension": "contract",
  "create-function": "expand",
  "drop-function": "contract",
  "replace-function": "expand",
  "create-trigger": "expand",
  "drop-trigger": "contract",
  "create-view": "expand",
  "drop-view": "contract",
  "replace-view": "expand",
  "create-matview": "expand",
  "drop-matview": "contract",
  "refresh-matview": "expand",
  "create-role": "expand",
  "alter-role": "contract",
  grant: "expand",
  revoke: "contract",
  "grant-default": "expand",
  "revoke-default": "contract",
  "rename-table": "contract",
  "rename-column": "contract",
  "rename-sequence": "contract",
  "backfill-expand": "expand",
  "backfill-contract": "contract",
  "enable-rls": "expand",
  "create-policy": "expand",
  "drop-policy": "contract",
  "disable-rls": "contract",
  "raw-sql": "unclassified",
} as const satisfies Record<string, MigrationClass>;

/** A planner operation. */
export type StepKind = keyof typeof STEP_CLASS;

/** Every kind, in table order. */
export const STEP_KINDS = Object.keys(STEP_CLASS) as readonly StepKind[];

/**
 * Class for one kind.
 *
 * @param kind - Planner operation
 * @returns The class stored on the step
 */
export function classOf(kind: StepKind): MigrationClass {
  return STEP_CLASS[kind];
}

/**
 * Strictest class in a plan.
 *
 * `contract` wins over `unclassified`, which wins over `expand`. An empty
 * list is `expand`.
 *
 * @param classes - One class per step
 * @returns The class of the plan header
 */
export function strictestClass(classes: readonly MigrationClass[]): MigrationClass {
  if (classes.includes("contract")) return "contract";
  if (classes.includes("unclassified")) return "unclassified";
  return "expand";
}

/**
 * Reports whether a plan comment names a kind.
 *
 * @param value - Text after `-- kind: `
 * @returns `true` when the text is a {@link StepKind}
 */
export function isStepKind(value: string): value is StepKind {
  return Object.hasOwn(STEP_CLASS, value);
}
