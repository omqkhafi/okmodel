/**
 * Plans and run state.
 *
 * Both hold target names. Neither holds a URL, a credential, a host, or a
 * tenant connection (invariant H, test `plan.no-connection`).
 */

import type { MigrationPlan } from "../migrations/plan.js";

/** How a step is classified for rollout and the protected-target policy. */
export type StepClass = "expand" | "contract" | "unclassified" | "reference" | "backfill";

/** One planned statement addressed to target names, not connections. */
export type PlannedStep = {
  /** Stable id. A checkpoint records this. */
  readonly id: string;
  /** Migration this step belongs to. */
  readonly migrationId: string;
  /** SQL. Schema-qualified. No connection string. */
  readonly sql: string;
  /** Expand, contract, or a class the policy treats on its own. */
  readonly class: StepClass;
  /** False for concurrent indexes, `ALTER TYPE … ADD VALUE`, and `VACUUM`. */
  readonly transactional: boolean;
  /** Lock mode name from the planner, or `none`. */
  readonly lock: string;
};

/**
 * A plan for a list of targets.
 *
 * `targetNames` are logical names. Resolving them happens when the runner
 * executes a step.
 */
export type TargetPlan = {
  /** Plan id. Run state points at this, not at a URL. */
  readonly id: string;
  /** Targets this plan applies to, by name. */
  readonly targetNames: readonly string[];
  /** Steps in apply order. */
  readonly steps: readonly PlannedStep[];
};

/** Per-target progress stored in the control database. */
export type TargetRunRecord = {
  /** Target name. */
  readonly name: string;
  /** Scheduler state. Not a connection. */
  readonly state: "pending" | "running" | "current" | "failed" | "skipped";
  /** Last committed step id, or null. */
  readonly checkpoint: string | null;
  /** Failure text, or null. */
  readonly error: string | null;
};

/** Run state for one invocation. Stored by target name. */
export type TargetRunState = {
  /** Run id. */
  readonly runId: string;
  /** Plan id. */
  readonly planId: string;
  /** One row per target in the run. */
  readonly targets: readonly TargetRunRecord[];
};

const FORBIDDEN_KEYS = new Set([
  "url",
  "password",
  "host",
  "port",
  "user",
  "username",
  "connection",
  "connectionstring",
  "credential",
  "credentials",
]);

/**
 * Wraps a P07 migration plan as a target plan.
 *
 * Drop steps are `contract`. Other steps use `stepClass`. Concurrent indexes,
 * enum value adds, and `VACUUM` are non-transactional.
 *
 * @param id - Plan id
 * @param targetNames - Logical target names
 * @param migration - Planner output
 * @param stepClass - Class for steps that are not drops
 * @returns A plan with no connection fields
 */
export function targetPlanFromMigration(
  id: string,
  targetNames: readonly string[],
  migration: MigrationPlan,
  stepClass: StepClass = "expand",
): TargetPlan {
  return {
    id,
    targetNames: [...targetNames],
    steps: migration.steps.map((step, index) => ({
      id: `${id}:${index}`,
      migrationId: id,
      sql: step.sql,
      class: step.action === "drop" ? "contract" : stepClass,
      transactional: transactionalSql(step.sql),
      lock: step.lock.mode,
    })),
  };
}

/**
 * Empty run state for a plan.
 *
 * @param runId - Run id
 * @param plan - Plan whose target names are copied
 * @returns Pending rows
 */
export function initialRunState(runId: string, plan: TargetPlan): TargetRunState {
  return {
    runId,
    planId: plan.id,
    targets: plan.targetNames.map((name) => ({
      name,
      state: "pending",
      checkpoint: null,
      error: null,
    })),
  };
}

/**
 * Lists paths whose key or string value is connection configuration.
 *
 * A URL, an IPv4 address, or a forbidden key is a hit. Schema names and SQL
 * are not.
 *
 * @param value - Plan, run state, or any JSON value
 * @returns Paths. Empty when the value holds no connection details
 */
export function connectionDetailHits(value: unknown): readonly string[] {
  const hits: string[] = [];
  walk(value, "$", hits);
  return hits;
}

function transactionalSql(sql: string): boolean {
  const text = sql.trim().toLowerCase();
  if (text.includes("concurrently")) return false;
  if (text.startsWith("vacuum")) return false;
  if (/\balter\s+type\b[\s\S]*\badd\s+value\b/.test(text)) return false;
  return true;
}

function walk(value: unknown, path: string, hits: string[]): void {
  if (typeof value === "string") {
    if (/postgres(ql)?:\/\//i.test(value) || /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(value)) {
      hits.push(path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walk(item, `${path}[${index}]`, hits);
    });
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) hits.push(`${path}.${key}`);
    walk(child, `${path}.${key}`, hits);
  }
}
