/**
 * Expand, contract, or raw SQL.
 *
 * Lives in the dialect layer so a DDL lowering can name a step kind.
 * `src/tooling/migrate/classify.ts` re-exports this module.
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

/**
 * How much a step can change what readers already depend on.
 *
 * `destructive` loses data or a name. `data` rewrites rows or refreshes a
 * computed object. `widening` relaxes a constraint. `additive` only adds.
 * The plan's class is the maximum. A new kind belongs in this table. The
 * operation-class test fails when a {@link StepKind} has no entry.
 */
export type OperationClass = "additive" | "widening" | "data" | "destructive";

/**
 * One class per planner kind.
 *
 * `drop-*` is destructive except `drop-not-null`, which the rule names as
 * widening. `create-*`, `add-*`, and `grant*` are additive. `revoke*` is
 * destructive. `backfill*`, `refresh-matview`, and `update-extension` are
 * data. A rename loses a name readers depend on. `raw-sql` is destructive
 * because the statement is unknown.
 */
export const OPERATION_CLASS = {
  "create-table": "additive",
  "drop-table": "destructive",
  "add-column": "additive",
  "add-column-required": "additive",
  "drop-column": "destructive",
  "set-column-type": "destructive",
  "set-not-null": "destructive",
  "drop-not-null": "widening",
  "set-default": "widening",
  "drop-default": "destructive",
  "add-identity": "additive",
  "drop-identity": "destructive",
  "set-identity-always": "destructive",
  "set-identity-by-default": "widening",
  "add-constraint": "additive",
  "validate-constraint": "additive",
  "drop-constraint": "destructive",
  "drop-not-null-check": "destructive",
  "rename-constraint": "destructive",
  "widen-check": "widening",
  "narrow-check": "destructive",
  "create-index": "additive",
  "drop-index": "destructive",
  "rename-index": "destructive",
  "create-sequence": "additive",
  "drop-sequence": "destructive",
  "create-enum": "additive",
  "recreate-enum": "destructive",
  "add-enum-value": "widening",
  "rename-enum": "destructive",
  "drop-enum": "destructive",
  "set-enum-column": "destructive",
  "create-domain": "additive",
  "drop-domain": "destructive",
  "add-domain-check": "additive",
  "validate-domain-check": "additive",
  "drop-domain-check": "destructive",
  "rename-domain-check": "destructive",
  "create-extension": "additive",
  "drop-extension": "destructive",
  "update-extension": "data",
  "move-extension": "destructive",
  "create-function": "additive",
  "drop-function": "destructive",
  "replace-function": "additive",
  "create-trigger": "additive",
  "drop-trigger": "destructive",
  "create-view": "additive",
  "drop-view": "destructive",
  "replace-view": "additive",
  "create-matview": "additive",
  "drop-matview": "destructive",
  "refresh-matview": "data",
  "create-role": "additive",
  "alter-role": "destructive",
  grant: "additive",
  revoke: "destructive",
  "grant-default": "additive",
  "revoke-default": "destructive",
  "rename-table": "destructive",
  "rename-column": "destructive",
  "rename-sequence": "destructive",
  "backfill-expand": "data",
  "backfill-contract": "data",
  "enable-rls": "additive",
  "create-policy": "additive",
  "drop-policy": "destructive",
  "disable-rls": "destructive",
  "raw-sql": "destructive",
} as const satisfies Record<StepKind, OperationClass>;

const OPERATION_RANK: Readonly<Record<OperationClass, number>> = {
  additive: 0,
  widening: 1,
  data: 2,
  destructive: 3,
};

/**
 * Class for one kind.
 *
 * @param kind - Planner operation
 * @returns The operation class
 */
export function operationClassOf(kind: StepKind): OperationClass {
  return OPERATION_CLASS[kind];
}

/**
 * Maximum class in a plan. An empty list is `additive`.
 *
 * @param classes - One class per step
 * @returns The plan class
 */
export function strictestOperation(classes: readonly OperationClass[]): OperationClass {
  let best: OperationClass = "additive";
  for (const item of classes) {
    if (OPERATION_RANK[item] > OPERATION_RANK[best]) best = item;
  }
  return best;
}

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
