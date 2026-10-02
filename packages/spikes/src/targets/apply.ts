/**
 * Applies one target's steps on a direct connection.
 *
 * Transactional steps of one migration commit together. A failure rolls that
 * migration back. A non-transactional step commits on its own. Resume skips
 * checkpointed steps and drops an invalid index before rebuilding it.
 */

import { quoteIdent } from "../catalog/sql.js";
import { openPostgresJs } from "../drivers/postgresjs.js";
import type { DriverConnection } from "../drivers/types.js";
import { TargetError } from "./error.js";
import { acquireTargetLock, releaseTargetLock } from "./lock.js";
import { bindSchema, type PlannedStep } from "./plan.js";
import { assertTargetPolicy, type OperationClass } from "./policy.js";

/** What one target's apply did. */
export type TargetApplyResult = {
  /** Last committed step, or null. */
  readonly checkpoint: string | null;
  /** Set when the target stopped on a step. */
  readonly error: string | null;
  /** Step that failed, when `error` is set. */
  readonly failedStep: string | null;
  /** Step ids committed by this call. */
  readonly applied: readonly string[];
  /** Per-step duration for steps this call ran. */
  readonly durations: readonly {
    readonly id: string;
    readonly durationMs: number;
    readonly lock: string;
  }[];
};

/**
 * Applies `steps` to one physical schema.
 *
 * @param options - URL, schema, steps, and the locks already recorded
 * @returns Checkpoints and the failure, if the run stopped
 */
export async function applyToTarget(options: {
  readonly targetName: string;
  readonly url: string;
  readonly schema: string;
  readonly steps: readonly PlannedStep[];
  readonly protected: boolean;
  readonly allowProtected?: boolean;
  readonly applicationName: string;
  readonly catalogHash: string;
  /** Step ids that must already be checkpointed before a contract step runs. */
  readonly requiredStepIds?: readonly string[];
  /** Called after each committed unit, before the next step. */
  readonly onUnit?: ((checkpoint: string) => Promise<void>) | undefined;
}): Promise<TargetApplyResult> {
  const pool = openPostgresJs(options.url, {
    max: 1,
    applicationName: options.applicationName,
    idleTimeout: 5,
  });
  if (pool.reserve === undefined) {
    await pool.close();
    throw new TargetError("OKM1845", `No direct connection for ${options.targetName}.`);
  }
  const connection = await pool.reserve();
  let applied: string[] = [];
  const durations: { id: string; durationMs: number; lock: string }[] = [];
  let checkpoint: string | null = null;
  try {
    await acquireTargetLock(connection, options.targetName);
    await connection.execute(`create schema if not exists ${quoteIdent(options.schema)}`);
    await ensureMeta(connection, options.schema);
    const done = await readCheckpoints(connection, options.schema);
    checkpoint = lastCheckpoint(options.steps, done);
    applied = [...done];
    for (const unit of units(options.steps)) {
      const pending = unit.filter(
        (step) => !done.has(step.id) && contractReady(step, done, options.requiredStepIds),
      );
      if (pending.length === 0) continue;
      try {
        if (unit[0]?.transactional === true) {
          await applyTransaction(connection, options, pending, done, durations);
        } else {
          await applyAutocommit(connection, options, pending, done, durations);
        }
        checkpoint = lastCheckpoint(options.steps, done);
        applied = [...done];
        if (checkpoint !== null) await options.onUnit?.(checkpoint);
      } catch (error) {
        if (error instanceof TargetError && error.code === "OKM1850") {
          return {
            checkpoint,
            error: error.message,
            failedStep: pending[0]?.id ?? null,
            applied,
            durations,
          };
        }
        return {
          checkpoint: lastCheckpoint(options.steps, done),
          error: messageOf(error),
          failedStep: pending[0]?.id ?? null,
          applied: [...done],
          durations,
        };
      }
      checkpoint = lastCheckpoint(options.steps, done);
      applied = [...done];
    }
    return { checkpoint, error: null, failedStep: null, applied, durations };
  } catch (error) {
    if (error instanceof TargetError && error.code === "OKM1522") throw error;
    return {
      checkpoint,
      error: messageOf(error),
      failedStep: null,
      applied,
      durations,
    };
  } finally {
    await releaseTargetLock(connection, options.targetName).catch(() => undefined);
    try {
      connection.release();
    } catch {
      // The backend is already gone.
    }
    await pool.close().catch(() => undefined);
  }
}

async function applyTransaction(
  connection: DriverConnection,
  options: {
    readonly schema: string;
    readonly protected: boolean;
    readonly allowProtected?: boolean;
    readonly catalogHash: string;
  },
  steps: readonly PlannedStep[],
  done: Set<string>,
  durations: { id: string; durationMs: number; lock: string }[],
): Promise<void> {
  await connection.execute("begin");
  try {
    for (const step of steps) {
      assertStep(options, step);
      const started = performance.now();
      await connection.execute(bindSchema(step.sql, options.schema));
      await writeCheckpoint(connection, options.schema, step.id, options.catalogHash);
      durations.push({ id: step.id, durationMs: performance.now() - started, lock: step.lock });
      done.add(step.id);
    }
    await connection.execute("commit");
  } catch (error) {
    await connection.execute("rollback").catch(() => undefined);
    for (const step of steps) done.delete(step.id);
    throw error;
  }
}

async function applyAutocommit(
  connection: DriverConnection,
  options: {
    readonly schema: string;
    readonly protected: boolean;
    readonly allowProtected?: boolean;
    readonly catalogHash: string;
  },
  steps: readonly PlannedStep[],
  done: Set<string>,
  durations: { id: string; durationMs: number; lock: string }[],
): Promise<void> {
  for (const step of steps) {
    assertStep(options, step);
    if (step.indexName !== undefined)
      await dropInvalidIndex(connection, options.schema, step.indexName);
    const started = performance.now();
    await connection.execute(bindSchema(step.sql, options.schema));
    await writeCheckpoint(connection, options.schema, step.id, options.catalogHash);
    durations.push({ id: step.id, durationMs: performance.now() - started, lock: step.lock });
    done.add(step.id);
  }
}

function assertStep(
  options: { readonly protected: boolean; readonly allowProtected?: boolean },
  step: PlannedStep,
): void {
  assertTargetPolicy(
    { protected: options.protected },
    step.class satisfies OperationClass,
    options.allowProtected === undefined ? {} : { allowProtected: options.allowProtected },
  );
}

function contractReady(
  step: PlannedStep,
  done: ReadonlySet<string>,
  required: readonly string[] | undefined,
): boolean {
  if (step.class !== "contract" || required === undefined) return true;
  return required.every((id) => done.has(id));
}

function units(steps: readonly PlannedStep[]): PlannedStep[][] {
  const groups: PlannedStep[][] = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    const sameMigration = last?.[0]?.migrationId === step.migrationId;
    if (
      last !== undefined &&
      last[0]?.transactional === true &&
      step.transactional &&
      sameMigration
    ) {
      last.push(step);
    } else {
      groups.push([step]);
    }
  }
  return groups;
}

async function ensureMeta(connection: DriverConnection, schema: string): Promise<void> {
  await connection.execute(`
    create table if not exists ${quoteIdent(schema)}.okm_meta (
      id text primary key,
      catalog_hash text not null,
      kind text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function readCheckpoints(connection: DriverConnection, schema: string): Promise<Set<string>> {
  const result = await connection.execute(`select id from ${quoteIdent(schema)}.okm_meta`);
  return new Set(result.rows.map((row) => row[0] ?? "").filter((id) => id.length > 0));
}

async function writeCheckpoint(
  connection: DriverConnection,
  schema: string,
  id: string,
  catalogHash: string,
): Promise<void> {
  await connection.execute(
    `insert into ${quoteIdent(schema)}.okm_meta (id, catalog_hash, kind) values ($1, $2, 'checkpoint')`,
    [id, catalogHash],
  );
}

async function dropInvalidIndex(
  connection: DriverConnection,
  schema: string,
  indexName: string,
): Promise<void> {
  const result = await connection.execute(
    `select c.relname
     from pg_index i
     join pg_class c on c.oid = i.indexrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relname = $2 and not i.indisvalid`,
    [schema, indexName],
  );
  if (result.rows.length === 0) return;
  await connection.execute(`drop index ${quoteIdent(schema)}.${quoteIdent(indexName)}`);
}

function lastCheckpoint(steps: readonly PlannedStep[], done: ReadonlySet<string>): string | null {
  let checkpoint: string | null = null;
  for (const step of steps) {
    if (done.has(step.id)) checkpoint = step.id;
  }
  return checkpoint;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
