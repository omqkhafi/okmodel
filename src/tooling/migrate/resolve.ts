/**
 * `okm migrate resolve`.
 *
 * Records a committed step a human finished, or marks it so the next apply
 * will try again. There is no skip. Only a step with an `okm_steps` row can
 * be resolved. The advisory lock is the same one apply holds.
 */

import { open } from "../../adapters/pg/postgresjs.js";
import type { DriverConnection } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import { quoteIdent } from "../../dialects/pg/ddl.js";
import { errorDoc } from "../errors/registry.js";
import { tagOutcome } from "../cli/outcome.js";
import { driverUrl } from "./driver-url.js";
import { catalogNamespace } from "./export.js";
import { loadMigrations } from "./files.js";
import { finishQuiet, sessionFailure } from "./lost.js";
import { ensureMigrationTables, lockKey, lockTarget } from "./apply.js";
import { asProject, projectPath, type ProjectContext } from "./paths.js";
import {
  assertDirectConnection,
  assertTargetPolicy,
  selectTarget,
  type InvokeFlags,
} from "./policy.js";
import { postgresStepEngine } from "./pg-probe.js";
import { probeStableBackend } from "./pooler-probe.js";
import { loadConfig } from "./project.js";
import type { PlanStep } from "./plan.js";
import { postgresStepJournal } from "./step-journal.js";
import { stepId, stepSqlHash, type CommittedStep } from "./step-engine.js";

/** What {@link resolveStep} did. */
export type ResolveResult = {
  readonly target: string;
  readonly step: string;
  readonly action: "applied" | "retry";
  readonly result: "recorded" | "retry";
};

/** Flags for {@link resolveProject}. */
export type ResolveFlags = InvokeFlags & {
  readonly applied: boolean;
  readonly retry: boolean;
  readonly acceptUnverified: boolean;
  readonly step: string;
};

/**
 * Resolves one step on the selected target.
 *
 * @param project - Project directory or {@link ProjectContext}
 * @param flags - The step id and exactly one of applied or retry
 * @returns The row `okm migrate resolve --json` prints as `data`
 */
export async function resolveProject(
  project: string | ProjectContext,
  flags: ResolveFlags,
): Promise<ResolveResult> {
  if (flags.applied === flags.retry) {
    throw tagOutcome(
      new OkmError("invalid", "Pass one of --applied or --retry.", {
        fix: { summary: "okm migrate resolve <migration>:<step> needs one of those." },
      }),
      "usage",
    );
  }
  const parsed = parseStepOperand(flags.step);
  if (parsed === undefined) {
    throw tagOutcome(
      new OkmError("invalid", `Step ${flags.step} is not a migration id and a step index.`, {
        fix: { summary: "Pass the id okm migrate status prints, such as 0001_init:0." },
      }),
      "usage",
    );
  }
  const { cwd } = asProject(project);
  const config = await loadConfig(project);
  const target = selectTarget(config, flags.target);
  assertTargetPolicy(target, "history-repair", flags.allowProtected);
  const migrations = loadMigrations(projectPath(cwd, config.migrations ?? "migrations"));
  const migration = migrations.find((item) => item.id === parsed.migrationId);
  const planStep = migration?.steps[parsed.stepIndex];
  if (migration === undefined || planStep === undefined) {
    throw new OkmError("invalid", `Step ${flags.step} is not in the migration files.`, {
      fix: { summary: "Pass a step id from the migration files on this project." },
    });
  }
  const namespace = catalogNamespace(config);
  return resolveOnTarget({
    url: target.url,
    target: target.name,
    allowPooler: flags.allowPooler || config.allowPooler === true,
    ...(namespace === "public" ? {} : { searchPath: namespace }),
    migrationId: parsed.migrationId,
    stepIndex: parsed.stepIndex,
    planStep,
    catalogHash: migration.catalogHash,
    finishes: parsed.stepIndex === migration.steps.length - 1,
    action: flags.applied ? "applied" : "retry",
    acceptUnverified: flags.acceptUnverified,
  });
}

/**
 * Text `okm migrate resolve` prints.
 *
 * @param result - What the command recorded
 * @returns Two lines, including the trailing newline
 */
export function formatResolve(result: ResolveResult): string {
  const verb = result.result === "recorded" ? "recorded" : "retry";
  return `target ${result.target}\n${verb} ${result.step}\n`;
}

function parseStepOperand(
  operand: string,
): { readonly migrationId: string; readonly stepIndex: number } | undefined {
  const colon = operand.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const migrationId = operand.slice(0, colon);
  const stepIndex = Number(operand.slice(colon + 1));
  if (
    !Number.isInteger(stepIndex) ||
    stepIndex < 0 ||
    operand.slice(colon + 1) !== String(stepIndex)
  ) {
    return undefined;
  }
  return { migrationId, stepIndex };
}

async function resolveOnTarget(input: {
  readonly url: string;
  readonly target: string;
  readonly allowPooler: boolean;
  readonly searchPath?: string;
  readonly migrationId: string;
  readonly stepIndex: number;
  readonly planStep: PlanStep;
  readonly catalogHash: string;
  readonly finishes: boolean;
  readonly action: "applied" | "retry";
  readonly acceptUnverified: boolean;
}): Promise<ResolveResult> {
  assertDirectConnection(input.url, input.allowPooler);
  const pool = open({
    url: driverUrl(input.url),
    max: 1,
    ...(input.searchPath !== undefined ? { searchPath: input.searchPath } : {}),
  });
  if (pool.reserve === undefined) {
    await pool.close();
    throw new OkmError("invalid", "The driver cannot reserve a connection.", {
      fix: { summary: "Resolve needs a driver with interactive transactions." },
    });
  }
  const connection = await pool.reserve();
  let locked = false;
  try {
    await probeStableBackend(input.url, () => backendPid(connection), input.allowPooler);
    await connection.execute("select set_config('lock_timeout', '5000', false)");
    await lockTarget(connection, input.target);
    locked = true;
    if (input.searchPath !== undefined && input.searchPath !== "public") {
      await connection.execute(`set search_path to ${quoteIdent(input.searchPath)}`);
    }
    await ensureMigrationTables((sql) => connection.execute(sql));
    const id = stepId(input.migrationId, input.stepIndex);
    const marker = await postgresStepJournal(connection).read(input.migrationId, input.stepIndex);
    if (marker === undefined) {
      throw new OkmError("invalid", `Step ${id} has no okm_steps row.`, {
        fix: {
          summary:
            "Resolve only a committed step that is in flight or broken. okm migrate status lists those rows.",
        },
      });
    }
    const step = committed(input);
    if (marker.sqlHash !== step.sqlHash) {
      throw new OkmError("OKM1556", `Step ${id} changed after it started.`, {
        fix: { summary: registryFix("OKM1556") },
      });
    }
    if (input.action === "retry") {
      await connection.execute(
        "update okm_steps set state = 'retry' where migration_id = $1 and step_index = $2",
        [input.migrationId, String(input.stepIndex)],
      );
      return { target: input.target, step: id, action: "retry", result: "retry" };
    }
    await acceptApplied(connection, step, input.planStep.probe, input.acceptUnverified);
    return { target: input.target, step: id, action: "applied", result: "recorded" };
  } catch (error) {
    throw sessionFailure(error) ?? error;
  } finally {
    if (locked) {
      await finishQuiet(() =>
        connection.execute("select pg_advisory_unlock(hashtext($1))", [lockKey(input.target)]),
      );
    }
    await finishQuiet(() => connection.release());
    await finishQuiet(() => pool.close());
  }
}

async function acceptApplied(
  connection: DriverConnection,
  step: CommittedStep,
  probe: string | undefined,
  acceptUnverified: boolean,
): Promise<void> {
  const engine = postgresStepEngine(
    connection,
    {
      kind: step.kind,
      sql: step.sql,
      lockTimeoutMs: 5_000,
      ...(probe !== undefined ? { probe } : {}),
    },
    () => Promise.resolve(),
  );
  if (!engine.probed) {
    if (!acceptUnverified) {
      throw new OkmError(
        "OKM1555",
        `Step ${stepId(step.migrationId, step.stepIndex)} has no probe.`,
        { fix: { summary: registryFix("OKM1555") } },
      );
    }
  } else {
    const result = await engine.probe();
    if (result !== "applied") {
      throw new OkmError(
        "OKM1554",
        `Step ${stepId(step.migrationId, step.stepIndex)} probe ${result}.`,
        { fix: { summary: registryFix("OKM1554") } },
      );
    }
  }
  await postgresStepJournal(connection).complete(step);
}

function committed(input: {
  readonly migrationId: string;
  readonly stepIndex: number;
  readonly planStep: PlanStep;
  readonly catalogHash: string;
  readonly finishes: boolean;
}): CommittedStep {
  return {
    migrationId: input.migrationId,
    stepIndex: input.stepIndex,
    kind: input.planStep.kind ?? "raw-sql",
    sql: input.planStep.sql,
    sqlHash: stepSqlHash(input.planStep.sql),
    stepClass: input.planStep.class,
    catalogHash: input.catalogHash,
    finishes: input.finishes,
  };
}

function registryFix(code: string): string {
  return errorDoc(code)?.fix ?? "Inspect the step and try again.";
}

async function backendPid(connection: DriverConnection): Promise<string> {
  const result = await connection.execute("select pg_backend_pid()::text");
  return result.rows[0]?.[0] ?? "";
}
