/**
 * Applies migrations on one target.
 *
 * A run holds a session advisory lock. Transactional steps of one migration
 * share a transaction. Steps Postgres cannot run there (`CREATE INDEX
 * CONCURRENTLY`, `ADD VALUE`, `VACUUM`) and backfill steps are their own
 * units. {@link runTarget} runs those units. Each finished step is a history
 * row. A later apply skips those rows. A backfill records each committed
 * batch in `okm_backfill` and resumes from that boundary.
 */

import { join } from "node:path";

import { open } from "../../adapters/pg/postgresjs.js";
import { catalogHash } from "../../contracts/catalog/document.js";
import { hasError, lintMigrationDirectory, lintRefusal } from "./lint.js";
import type { DriverConnection } from "../../contracts/driver.js";
import { OkmError } from "../../contracts/error.js";
import { assertCreateRole, currentUser, roleExists } from "../../dialects/pg/role/check.js";
import { changesRole } from "../../dialects/pg/role/sql.js";
import { batchSizeField } from "./backfill.js";
import { assumeRole, runTarget, type BackfillBatch } from "./runner.js";
import { assertExtensionsAvailable } from "./extensions.js";
import { assertUuidV7Available } from "./engine.js";
import { loadConfig, projectHead } from "./project.js";
import { planMigration, type PlanStep } from "./plan.js";
import type { StoredMigration } from "./files.js";
import { loadMigrations } from "./files.js";
import {
  assertDirectConnection,
  assertTargetPolicy,
  selectTarget,
  type InvokeFlags,
} from "./policy.js";

/** One step with its index in the migration file. */
export type IndexedStep = {
  readonly index: number;
  readonly step: PlanStep;
};

/** Steps that commit together, or one step that cannot. */
export type ApplyUnit = {
  readonly migrationId: string;
  readonly catalogHash: string;
  /** True when this unit is the last step of its migration. */
  readonly finishes: boolean;
  readonly transactional: boolean;
  readonly steps: readonly IndexedStep[];
};

/** What {@link applyTarget} needs. The URL is resolved by the caller. */
export type ApplyRequest = {
  readonly url: string;
  readonly target: string;
  readonly protected: boolean;
  readonly allowProtected?: boolean;
  readonly allowPooler?: boolean;
  readonly searchPath?: string;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly retries?: number;
  readonly migrations: readonly StoredMigration[];
  /** Runs after the advisory lock is held and before the first step. */
  readonly onLocked?: () => void;
  /**
   * Role that runs the migration.
   *
   * When it already exists and is not `current_user`, the runner issues one
   * `SET ROLE` before any statement. That statement is not a plan step.
   */
  readonly migrationRole?: string;
  /**
   * Schema the migration role may create in.
   *
   * When this run creates that role, the runner grants `USAGE` and `CREATE`
   * on this schema before `SET ROLE`. The default is `public`.
   */
  readonly schema?: string;
  /** Milliseconds to wait after each committed backfill batch. */
  readonly backfillPauseMs?: number;
  /** `statement_timeout` for one backfill batch. Falls back to {@link ApplyRequest.statementTimeoutMs}. */
  readonly backfillStatementTimeoutMs?: number;
  /** One line after each committed backfill batch. */
  readonly onProgress?: (line: string) => void;
  /** Runs after each committed backfill batch, before the pause. */
  readonly afterBatch?: (batch: BackfillBatch) => void | Promise<void>;
  /**
   * Migrations directory to lint before any DDL.
   *
   * Only a migration with a step missing from `okm_history` is checked.
   * `push` omits this: its steps are not files.
   */
  readonly lintDirectory?: string;
};

/** Migrations that ran at least one step in this invocation. */
export type ApplyReport = {
  readonly target: string;
  readonly applied: readonly string[];
  /** Set when the runner issued `SET ROLE` at session start. */
  readonly setRole?: string;
};

const DEFAULT_LOCK_MS = 5_000;
const DEFAULT_STATEMENT_MS = 30_000;
const DEFAULT_RETRIES = 3;

const META = `create table if not exists okm_meta (
  id text primary key,
  catalog_hash text not null,
  migration_id text not null
)`;

const HISTORY = `create table if not exists okm_history (
  migration_id text not null,
  step_index integer not null,
  class text not null,
  catalog_hash text not null,
  applied_at timestamptz not null default now(),
  primary key (migration_id, step_index)
)`;

const BACKFILL = `create table if not exists okm_backfill (
  migration_id text not null,
  step_index integer not null,
  last_key text,
  rows_touched bigint not null default 0,
  batches integer not null default 0,
  state text not null,
  updated_at timestamptz not null default now(),
  primary key (migration_id, step_index)
)`;

/**
 * Groups pending steps into the transactions apply will run.
 *
 * A step Postgres cannot run inside a transaction is its own unit even when
 * the plan marked it transactional.
 *
 * @param migration - One file
 * @param done - Keys `${migrationId}:${stepIndex}` already in history
 * @returns Units in apply order
 */
export function applyUnits(
  migration: StoredMigration,
  done: ReadonlySet<string>,
): readonly ApplyUnit[] {
  const pending: IndexedStep[] = [];
  for (let index = 0; index < migration.steps.length; index += 1) {
    if (done.has(`${migration.id}:${String(index)}`)) continue;
    const step = migration.steps[index];
    if (step !== undefined) pending.push({ index, step });
  }
  const units: ApplyUnit[] = [];
  let batch: IndexedStep[] = [];
  const flush = (): void => {
    if (batch.length === 0) return;
    const last = batch.at(-1);
    units.push({
      migrationId: migration.id,
      catalogHash: migration.catalogHash,
      finishes: last !== undefined && last.index === migration.steps.length - 1,
      transactional: true,
      steps: batch,
    });
    batch = [];
  };
  for (const item of pending) {
    if (
      item.step.backfill === undefined &&
      item.step.transactional &&
      !outsideTransaction(item.step.sql)
    ) {
      batch.push(item);
      continue;
    }
    flush();
    units.push({
      migrationId: migration.id,
      catalogHash: migration.catalogHash,
      finishes: item.index === migration.steps.length - 1,
      transactional: false,
      steps: [item],
    });
  }
  flush();
  return units;
}

/**
 * Applies pending migrations on one target.
 *
 * The connection is reserved for the whole run so the advisory lock stays
 * session-scoped. Lock timeout retries that step, including `NOT VALID`,
 * `VALIDATE CONSTRAINT`, `SET NOT NULL`, `ADD CONSTRAINT … USING INDEX`, and
 * a concurrent index create or drop. Any other failure stops at that step.
 *
 * @param request - Target, flags, and the migrations to consider
 * @returns The target and the migration ids that ran
 */
export async function applyTarget(request: ApplyRequest): Promise<ApplyReport> {
  assertDirectConnection(request.url, request.allowPooler === true);
  const pool = open({
    url: request.url,
    max: 1,
    ...(request.searchPath !== undefined ? { searchPath: request.searchPath } : {}),
  });
  if (pool.reserve === undefined) {
    await pool.close();
    throw new OkmError("invalid", "The driver cannot reserve a connection.", {
      fix: { summary: "Apply needs a driver with interactive transactions." },
    });
  }
  const connection = await pool.reserve();
  let locked = false;
  try {
    await setTimeouts(connection, request);
    await lockTarget(connection, request.target);
    locked = true;
    request.onLocked?.();
    if (request.lintDirectory !== undefined) {
      await refusePendingLint(connection, request.lintDirectory, request.migrations);
    }
    const session: { setRole?: string } = {};
    await prepareMigrationRole(connection, request, session);
    await assertExtensionsAvailable(connection, request.migrations);
    await assertUuidV7Available(connection, request.migrations);
    await connection.execute(META);
    await connection.execute(HISTORY);
    await connection.execute(BACKFILL);
    const done = await readDone(connection);
    const units = request.migrations.flatMap((migration) => applyUnits(migration, done));
    return await runTarget(
      connection,
      {
        policy: request,
        units,
        retries: request.retries ?? DEFAULT_RETRIES,
        lockTimeoutMs: request.lockTimeoutMs ?? DEFAULT_LOCK_MS,
        statementTimeoutMs: request.statementTimeoutMs ?? DEFAULT_STATEMENT_MS,
        backfillStatementTimeoutMs:
          request.backfillStatementTimeoutMs ?? request.statementTimeoutMs ?? DEFAULT_STATEMENT_MS,
        ...(request.backfillPauseMs !== undefined
          ? { backfillPauseMs: request.backfillPauseMs }
          : {}),
        ...(request.migrationRole !== undefined ? { migrationRole: request.migrationRole } : {}),
        ...(request.schema !== undefined ? { schema: request.schema } : {}),
        ...(request.onProgress !== undefined ? { onProgress: request.onProgress } : {}),
        ...(request.afterBatch !== undefined ? { afterBatch: request.afterBatch } : {}),
      },
      session,
    );
  } finally {
    if (locked)
      await connection.execute("select pg_advisory_unlock(hashtext($1))", [
        lockKey(request.target),
      ]);
    await connection.release();
    await pool.close();
  }
}

/**
 * Applies the migrations in the project to the selected target.
 *
 * Pending migrations are linted after `okm_history` is read and before any
 * DDL. A migration the target already applied is left as it ran.
 *
 * @param cwd - Project directory
 * @param flags - `--target`, protection, pooler, and timeouts
 * @param write - Receives each backfill progress line, including the newline
 * @returns Text for stdout, including the target name
 */
export async function applyProject(
  cwd: string,
  flags: InvokeFlags,
  write?: (text: string) => void,
): Promise<string> {
  const config = await loadConfig(cwd);
  const target = selectTarget(config, flags.target);
  const directory = joinMigrations(cwd, config.migrations);
  const migrations = loadMigrations(directory);
  if (migrations.length === 0) return `target ${target.name}\nnothing to apply\n`;
  const progress: string[] = [];
  const report = await applyTarget({
    url: target.url,
    target: target.name,
    protected: target.protected,
    allowProtected: flags.allowProtected,
    allowPooler: flags.allowPooler || config.allowPooler === true,
    ...(flags.lockTimeoutMs !== undefined
      ? { lockTimeoutMs: flags.lockTimeoutMs }
      : config.timeouts?.lock !== undefined
        ? { lockTimeoutMs: config.timeouts.lock }
        : {}),
    ...(flags.statementTimeoutMs !== undefined
      ? { statementTimeoutMs: flags.statementTimeoutMs }
      : config.timeouts?.statement !== undefined
        ? { statementTimeoutMs: config.timeouts.statement }
        : {}),
    ...backfillTiming(config.backfill),
    migrations,
    ...(config.roles !== undefined ? { migrationRole: config.roles.migration } : {}),
    lintDirectory: directory,
    onProgress: (line) => {
      if (write !== undefined) write(`${line}\n`);
      else progress.push(line);
    },
  });
  const summary = formatReport(report);
  if (write !== undefined || progress.length === 0) return summary;
  return `${progress.join("\n")}\n${summary}`;
}

/**
 * Prototype sync. Blocked on a protected target.
 *
 * A target named production is not special. Protection is the `protected`
 * flag (spec §19.8). The plan's statements run as one migration.
 *
 * @param cwd - Project directory
 * @param flags - Target and protection flags
 * @returns Text for stdout
 */
export async function pushProject(cwd: string, flags: InvokeFlags): Promise<string> {
  const config = await loadConfig(cwd);
  const target = selectTarget(config, flags.target);
  assertTargetPolicy(target, "push", flags.allowProtected);
  const head = await projectHead(cwd);
  const plan = planMigration({
    before: head.previous,
    after: head.catalog,
    renames: head.renames,
    name: "push",
    ...batchSizeField(config.backfill?.batchSize),
  });
  if (plan.steps.length === 0) return `target ${target.name}\nno changes\n`;
  const report = await applyTarget({
    url: target.url,
    target: target.name,
    protected: target.protected,
    allowProtected: flags.allowProtected,
    allowPooler: flags.allowPooler || config.allowPooler === true,
    ...backfillTiming(config.backfill),
    migrations: [
      {
        id: "push",
        catalogHash: catalogHash(head.catalog),
        steps: plan.steps,
      },
    ],
    ...(config.roles !== undefined ? { migrationRole: config.roles.migration } : {}),
  });
  return formatReport(report);
}

/**
 * Pause and statement timeout `defineConfig({ backfill })` sets for a run.
 *
 * Omitted fields stay unset so the runner uses its built-in defaults.
 *
 * @param backfill - Config block, when the project set one
 * @returns The fields {@link applyTarget} reads
 */
export function backfillTiming(
  backfill:
    | {
        readonly pauseMs?: number;
        readonly statementTimeoutMs?: number;
      }
    | undefined,
): {
  readonly backfillPauseMs?: number;
  readonly backfillStatementTimeoutMs?: number;
} {
  return {
    ...(backfill?.pauseMs !== undefined ? { backfillPauseMs: backfill.pauseMs } : {}),
    ...(backfill?.statementTimeoutMs !== undefined
      ? { backfillStatementTimeoutMs: backfill.statementTimeoutMs }
      : {}),
  };
}

function formatReport(report: ApplyReport): string {
  const role = report.setRole !== undefined ? `set role ${report.setRole}\n` : "";
  if (report.applied.length === 0) return `target ${report.target}\n${role}nothing to apply\n`;
  return `target ${report.target}\n${role}${report.applied.map((id) => `applied ${id}`).join("\n")}\n`;
}

function joinMigrations(cwd: string, migrations: string | undefined): string {
  return join(cwd, migrations ?? "migrations");
}

async function setTimeouts(connection: DriverConnection, request: ApplyRequest): Promise<void> {
  const lock = request.lockTimeoutMs ?? DEFAULT_LOCK_MS;
  const statement = request.statementTimeoutMs ?? DEFAULT_STATEMENT_MS;
  await connection.execute("select set_config('lock_timeout', $1, false)", [String(lock)]);
  await connection.execute("select set_config('statement_timeout', $1, false)", [
    String(statement),
  ]);
}

async function lockTarget(connection: DriverConnection, target: string): Promise<void> {
  const result = await connection.execute("select pg_try_advisory_lock(hashtext($1))", [
    lockKey(target),
  ]);
  if (!wireTrue(result.rows[0]?.[0])) {
    throw new OkmError("OKM1522", `Another apply holds the lock for ${target}.`, {
      kind: "conflict",
      fix: {
        summary:
          "Wait for that apply to finish. Do not start a second apply against the same target.",
      },
    });
  }
}

function lockKey(target: string): string {
  return `okm:${target}`;
}

/**
 * Refuses when a migration that still has a step to run has an error finding.
 *
 * `okm_history` is read first. When that table does not exist, every
 * migration is pending. The throw happens before any DDL or data statement.
 *
 * @param connection - Reserved connection, after the advisory lock
 * @param directory - Migrations directory, walked from the first file
 * @param migrations - Files apply loaded, in apply order
 */
async function refusePendingLint(
  connection: DriverConnection,
  directory: string,
  migrations: readonly StoredMigration[],
): Promise<void> {
  const pending = await pendingMigrationIds(connection, migrations);
  const findings = lintMigrationDirectory(directory, pending);
  if (hasError(findings)) throw lintRefusal(findings);
}

/**
 * Migration ids with at least one step absent from `okm_history`.
 *
 * @param connection - Reserved connection
 * @param migrations - Files in apply order
 * @returns Every id when `okm_history` does not exist yet
 */
async function pendingMigrationIds(
  connection: DriverConnection,
  migrations: readonly StoredMigration[],
): Promise<ReadonlySet<string>> {
  const present = await connection.execute("select to_regclass('okm_history') is not null");
  if (!wireTrue(present.rows[0]?.[0])) return new Set(migrations.map((migration) => migration.id));
  const done = await readDone(connection);
  const pending = new Set<string>();
  for (const migration of migrations) {
    for (let index = 0; index < migration.steps.length; index += 1) {
      if (!done.has(`${migration.id}:${String(index)}`)) {
        pending.add(migration.id);
        break;
      }
    }
  }
  return pending;
}

async function readDone(connection: DriverConnection): Promise<Set<string>> {
  const result = await connection.execute("select migration_id, step_index::text from okm_history");
  const done = new Set<string>();
  for (const row of result.rows) {
    const id = row[0];
    const step = row[1];
    if (id !== null && step !== null) done.add(`${id}:${step}`);
  }
  return done;
}

async function prepareMigrationRole(
  connection: DriverConnection,
  request: ApplyRequest,
  session: { setRole?: string },
): Promise<void> {
  const role = request.migrationRole;
  const changes = request.migrations.some((migration) =>
    migration.steps.some((step) => changesRole(step.sql)),
  );
  if (role === undefined) {
    if (changes) await assertCreateRole(connection, await currentUser(connection));
    return;
  }
  const current = await currentUser(connection);
  const exists = await roleExists(connection, role);
  if (changes) await assertCreateRole(connection, exists && current !== role ? role : current);
  if (exists && current !== role) await assumeRole(connection, role, session);
}

function outsideTransaction(sql: string): boolean {
  const text = sql.trim().toLowerCase();
  if (text.startsWith("vacuum")) return true;
  if (/^alter\s+type\b/.test(text) && /\badd\s+value\b/.test(text)) return true;
  if (/^create\s+(?:unique\s+)?index\s+concurrently\b/.test(text)) return true;
  if (/^drop\s+index\s+concurrently\b/.test(text)) return true;
  return false;
}

function wireTrue(value: string | null | undefined): boolean {
  return value === "t" || value === "true";
}
