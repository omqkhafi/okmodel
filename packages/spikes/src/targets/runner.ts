/**
 * One runner for migrate apply.
 *
 * Expand runs on the shared target, then on tenants. Contract runs on tenants,
 * then on the shared target only when every tenant in scope succeeded. A second
 * pass picks up tenants registered while the run was in progress.
 */

import type { Sql } from "postgres";

import { applyToTarget, type TargetApplyResult } from "./apply.js";
import { TargetError } from "./error.js";
import type { PlannedStep, TargetPlan } from "./plan.js";
import type { RegistryRole } from "./registry.js";
import { connectionUrl, resolveTarget, type TargetSource } from "./resolver.js";
import { saveControlRow, type ControlRow } from "./state.js";
import { sharedTarget, type Target, type TargetStrategy } from "./target.js";
import { schemaNameForTenant } from "./sanitize.js";

/** Flags from `okm migrate apply`. */
export type Rollout = {
  /** `--target`, repeatable. */
  readonly targets?: readonly string[];
  /** `--class`. */
  readonly class?: "shared" | "tenant";
  /** `--canary`. First n tenants in registry order. */
  readonly canary?: number;
  /** `--concurrency`. Default depends on the tenancy strategy. */
  readonly concurrency?: number;
  /** `--max-failures`. Default 3. */
  readonly maxFailures?: number;
  /** `--allow-protected`. */
  readonly allowProtected?: boolean;
};

/** One target in the runner report. */
export type TargetReport = {
  readonly name: string;
  readonly state: "current" | "failed" | "pending" | "running" | "skipped";
  readonly checkpoint: string | null;
  readonly error: string | null;
  readonly durations: TargetApplyResult["durations"];
};

/** What `applyRun` returns. */
export type ApplyReport = {
  /** 0 when no target failed. Pending targets do not fail the run. */
  readonly exitCode: number;
  /** Concurrency the run used. */
  readonly concurrency: number;
  /** Per-target results, including targets left pending. */
  readonly targets: readonly TargetReport[];
  /** Tenant names discovered after the run started. */
  readonly secondPass: readonly string[];
};

/**
 * Default parallelism.
 *
 * Schema-per-tenant tenants share one database, so the default is 2.
 * Database-per-tenant tenants do not, so the default is 8.
 *
 * @param strategy - Physical tenancy
 * @returns The default `--concurrency`
 */
export function defaultConcurrency(strategy: "schemaPerTenant" | "databasePerTenant"): number {
  return strategy === "schemaPerTenant" ? 2 : 8;
}

/**
 * Applies a plan to the selected targets.
 *
 * Run state is written to the control database as each unit commits. The plan
 * itself is not modified.
 *
 * @param options - Plan, registry, control connection, and rollout flags
 * @returns Per-target results and the exit code
 */
export async function applyRun(options: {
  readonly source: TargetSource;
  readonly shared: Target;
  readonly plan: TargetPlan;
  readonly strategy: "schemaPerTenant" | "databasePerTenant";
  readonly control: Sql;
  readonly controlSchema: string;
  readonly runId: string;
  readonly rollout?: Rollout;
  readonly role?: RegistryRole;
  readonly catalogHash?: string;
  readonly applicationName?: string;
  readonly onTargetStart?: ((name: string) => void) | undefined;
  readonly onTargetFinish?: ((name: string) => void) | undefined;
}): Promise<ApplyReport> {
  const rollout = options.rollout ?? {};
  assertExplicitTarget(options.source, rollout);
  const role = options.role ?? "migration";
  const catalogHash = options.catalogHash ?? "spike";
  const applicationName = options.applicationName ?? `okm-p08b-${options.runId}`;
  const concurrency = rollout.concurrency ?? defaultConcurrency(options.strategy);
  const maxFailures = rollout.maxFailures ?? 3;
  const initialTenants = options.source.tenants.list();
  const initialNames = new Set(initialTenants.map((target) => target.name));
  const selected = selectTargets(options.shared, initialTenants, rollout);
  const reports = new Map<string, TargetReport>();
  let failures = 0;

  for (const target of selected.all) {
    reports.set(target.name, {
      name: target.name,
      state: "pending",
      checkpoint: null,
      error: null,
      durations: [],
    });
    await writeRow(options, target, reports.get(target.name) as TargetReport);
  }

  await runTargets(selected.shared, stepsFor("shared", options.plan, "expand"), {
    ...options,
    role,
    catalogHash,
    applicationName,
    concurrency: 1,
    reports,
    failures: () => failures,
    addFailure: () => {
      failures += 1;
    },
    maxFailures,
    onTargetStart: options.onTargetStart,
    onTargetFinish: options.onTargetFinish,
  });

  await runTargets(selected.tenants, stepsFor("tenant", options.plan, "expand"), {
    ...options,
    role,
    catalogHash,
    applicationName,
    concurrency,
    reports,
    failures: () => failures,
    addFailure: () => {
      failures += 1;
    },
    maxFailures,
    onTargetStart: options.onTargetStart,
    onTargetFinish: options.onTargetFinish,
  });

  await runTargets(selected.tenants, stepsFor("tenant", options.plan, "contract"), {
    ...options,
    role,
    catalogHash,
    applicationName,
    concurrency,
    reports,
    failures: () => failures,
    addFailure: () => {
      failures += 1;
    },
    maxFailures,
    requiredStepIds: stepsFor("tenant", options.plan, "expand").map((step) => step.id),
    onTargetStart: options.onTargetStart,
    onTargetFinish: options.onTargetFinish,
  });

  const tenantScope = selected.tenants.map((target) => reports.get(target.name));
  const blocked = tenantScope.some(
    (report) => report?.state === "failed" || report?.state === "pending",
  );
  if (!blocked) {
    await runTargets(selected.shared, stepsFor("shared", options.plan, "contract"), {
      ...options,
      role,
      catalogHash,
      applicationName,
      concurrency: 1,
      reports,
      failures: () => failures,
      addFailure: () => {
        failures += 1;
      },
      maxFailures,
      onTargetStart: options.onTargetStart,
      onTargetFinish: options.onTargetFinish,
    });
  } else {
    const sharedContract = stepsFor("shared", options.plan, "contract");
    if (sharedContract.length > 0) {
      for (const target of selected.shared) {
        const current = reports.get(target.name);
        if (current === undefined || current.state === "failed") continue;
        const pending = { ...current, state: "pending" as const };
        reports.set(target.name, pending);
        await writeRow(options, target, pending);
      }
    }
  }

  const late = options.source.tenants.list().filter((target) => !initialNames.has(target.name));
  if (late.length > 0 && failures < maxFailures) {
    for (const target of late) {
      reports.set(target.name, emptyReport(target.name));
      await writeRow(options, target, reports.get(target.name) as TargetReport);
    }
    await runTargets(late, stepsFor("tenant", options.plan, "expand"), {
      ...options,
      role,
      catalogHash,
      applicationName,
      concurrency,
      reports,
      failures: () => failures,
      addFailure: () => {
        failures += 1;
      },
      maxFailures,
      onTargetStart: options.onTargetStart,
      onTargetFinish: options.onTargetFinish,
    });
    await runTargets(late, stepsFor("tenant", options.plan, "contract"), {
      ...options,
      role,
      catalogHash,
      applicationName,
      concurrency,
      reports,
      failures: () => failures,
      addFailure: () => {
        failures += 1;
      },
      maxFailures,
      requiredStepIds: stepsFor("tenant", options.plan, "expand").map((step) => step.id),
      onTargetStart: options.onTargetStart,
      onTargetFinish: options.onTargetFinish,
    });
  }

  const targets = [...reports.values()];
  return {
    exitCode: targets.some((target) => target.state === "failed") ? 1 : 0,
    concurrency,
    targets,
    secondPass: late.map((target) => target.name),
  };
}

type RunContext = {
  readonly source: TargetSource;
  readonly plan: TargetPlan;
  readonly strategy: TargetStrategy;
  readonly control: Sql;
  readonly controlSchema: string;
  readonly runId: string;
  readonly rollout?: Rollout;
  readonly role: RegistryRole;
  readonly catalogHash: string;
  readonly applicationName: string;
  readonly concurrency: number;
  readonly maxFailures: number;
  readonly requiredStepIds?: readonly string[];
  readonly reports: Map<string, TargetReport>;
  readonly failures: () => number;
  readonly addFailure: () => void;
  readonly onTargetStart?: ((name: string) => void) | undefined;
  readonly onTargetFinish?: ((name: string) => void) | undefined;
};

async function runTargets(
  targets: readonly Target[],
  steps: readonly PlannedStep[],
  context: RunContext,
): Promise<void> {
  if (targets.length === 0 || steps.length === 0) return;
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (context.failures() >= context.maxFailures) return;
      const index = next;
      next += 1;
      const target = targets[index];
      if (target === undefined) return;
      if (context.failures() >= context.maxFailures) return;
      if ((context.reports.get(target.name)?.state ?? "pending") === "failed") continue;
      context.onTargetStart?.(target.name);
      try {
        await runOne(target, steps, context);
      } finally {
        context.onTargetFinish?.(target.name);
      }
    }
  }
  const workers = Array.from({ length: Math.max(1, context.concurrency) }, () => worker());
  await Promise.all(workers);
}

async function runOne(
  target: Target,
  steps: readonly PlannedStep[],
  context: RunContext,
): Promise<void> {
  const current = context.reports.get(target.name) ?? emptyReport(target.name);
  context.reports.set(target.name, { ...current, state: "running" });
  await writeRow(context, target, context.reports.get(target.name) as TargetReport);
  const schema = schemaFor(target, context.strategy);
  let result: TargetApplyResult;
  try {
    const allowProtected = context.rollout?.allowProtected;
    result = await applyToTarget({
      targetName: target.name,
      url: connectionUrl(resolveTarget(context.source, target, context.role)),
      schema,
      steps,
      protected: target.protected,
      ...(allowProtected === undefined ? {} : { allowProtected }),
      applicationName: context.applicationName,
      catalogHash: context.catalogHash,
      ...(context.requiredStepIds === undefined
        ? {}
        : { requiredStepIds: context.requiredStepIds }),
      onUnit: async (checkpoint) => {
        const previous = context.reports.get(target.name) ?? emptyReport(target.name);
        const nextReport: TargetReport = { ...previous, checkpoint, state: "running" };
        context.reports.set(target.name, nextReport);
        await writeRow(context, target, nextReport);
      },
    });
  } catch (error) {
    if (error instanceof TargetError && error.code === "OKM1522") {
      const refused: TargetReport = {
        ...current,
        state: "failed",
        error: error.message,
      };
      context.reports.set(target.name, refused);
      context.addFailure();
      await writeRow(context, target, refused);
      return;
    }
    throw error;
  }
  const wanted = steps.map((step) => step.id);
  const finished = result.error === null && wanted.every((id) => result.applied.includes(id));
  const report: TargetReport = {
    name: target.name,
    state: result.error === null ? (finished ? "current" : "pending") : "failed",
    checkpoint: result.checkpoint,
    error: result.error,
    durations: [...current.durations, ...result.durations],
  };
  if (report.state === "failed") context.addFailure();
  context.reports.set(target.name, report);
  await writeRow(context, target, report);
}

function schemaFor(target: Target, strategy: TargetStrategy): string {
  if (target.class === "tenant" && strategy === "schemaPerTenant") {
    return schemaNameForTenant(target.tenantId ?? "");
  }
  if (target.class === "tenant") return "public";
  return target.namespace;
}

function stepsFor(
  scope: "shared" | "tenant",
  plan: TargetPlan,
  phase: "expand" | "contract",
): readonly PlannedStep[] {
  return plan.steps.filter((step) => {
    if (step.scope !== scope) return false;
    if (phase === "contract") return step.class === "contract";
    return step.class !== "contract";
  });
}

function selectTargets(
  shared: Target,
  tenants: readonly Target[],
  rollout: Rollout,
): {
  readonly shared: readonly Target[];
  readonly tenants: readonly Target[];
  readonly all: readonly Target[];
} {
  const named = rollout.targets;
  const sharedSelected =
    rollout.class === "tenant"
      ? []
      : named === undefined
        ? [shared]
        : named.includes(shared.name)
          ? [shared]
          : [];
  let tenantSelected = rollout.class === "shared" ? [] : [...tenants];
  if (named !== undefined) {
    const allowed = new Set(named);
    tenantSelected = tenantSelected.filter((target) => allowed.has(target.name));
  }
  if (rollout.canary !== undefined) {
    tenantSelected = tenantSelected.slice(0, rollout.canary);
  }
  return {
    shared: sharedSelected,
    tenants: tenantSelected,
    all: [...sharedSelected, ...tenantSelected],
  };
}

function assertExplicitTarget(source: TargetSource, rollout: Rollout): void {
  const named = source.targets === undefined ? 0 : Object.keys(source.targets).length;
  if (named > 1 && rollout.targets === undefined && rollout.class !== "tenant") {
    throw new TargetError(
      "OKM1853",
      "Several targets exist. Pass --target. The command does not choose an environment.",
    );
  }
}

function emptyReport(name: string): TargetReport {
  return { name, state: "pending", checkpoint: null, error: null, durations: [] };
}

async function writeRow(
  context: {
    readonly control: Sql;
    readonly controlSchema: string;
    readonly runId: string;
    readonly plan: TargetPlan;
  },
  target: Target,
  report: TargetReport,
): Promise<void> {
  const row: ControlRow = {
    planId: context.plan.id,
    name: report.name,
    class: target.class,
    state: report.state,
    checkpoint: report.checkpoint,
    error: report.error,
  };
  await saveControlRow(context.control, context.controlSchema, context.runId, row);
}

/**
 * The shared target a single `database` shorthand stands for.
 *
 * Re-exported here so a run can name its control destination without a URL on
 * the plan.
 *
 * @param namespace - Static schema for shared objects
 * @param protectedTarget - Protection flag
 * @returns The shared target
 */
export function controlSharedTarget(namespace: string, protectedTarget = false): Target {
  return sharedTarget("default", protectedTarget, namespace);
}
